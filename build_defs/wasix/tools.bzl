"""Portable frontend payloads depend only on their actual command producers."""

load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")
load("//build_defs/release:identity.bzl", "ReleaseIdentityInfo")
load("//build_defs/release:supplier.bzl", "ShippingSupplierInfo", "merge_shipping_suppliers")
load(":npm.bzl", "RUNTIME_NPM_NOTICES")
load(":wasm.bzl", "WasmModuleInfo")

def _tools_impl(ctx):
    product = ctx.attr.product[ReleaseIdentityInfo]
    runtime = ctx.attr.runtime_product[ReleaseIdentityInfo]
    if product.id != "postgres-tools-wasix" or runtime.id != "liboliphaunt-wasix":
        fail("WASIX tools payload requires its canonical product/runtime owners")
    pg_dump = ctx.attr.pg_dump[WasmModuleInfo].module
    psql = ctx.attr.psql[WasmModuleInfo].module
    inputs = [pg_dump, psql, ctx.file.postgres_source, ctx.file.postgres_series, ctx.file.icu_source] + ctx.files.patches
    notices = {}
    for target, destination in ctx.attr.notices.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory or destination in notices:
            fail("WASIX tools notice must be one unique declared file")
        notices[destination] = files[0].path
        inputs += files
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode({
        "pgDump": pg_dump.path,
        "psql": psql.path,
        "version": product.version,
        "runtimeVersion": runtime.version,
        "postgresSource": ctx.file.postgres_source.path,
        "postgresSeries": ctx.file.postgres_series.path,
        "patches": {file.short_path: file.path for file in ctx.files.patches},
        "icuSource": ctx.file.icu_source.path,
        "notices": notices,
    }))
    output = ctx.actions.declare_directory(ctx.label.name)
    arguments = ctx.actions.args()
    arguments.add_all(["--spec", specification, "--output", output.path, "--manifest-tool", ctx.executable._manifest_tool])
    bun_file_action(
        ctx,
        ctx.file._packager,
        arguments = [arguments],
        inputs = depset(inputs + [specification]),
        source_files = ctx.files._helpers,
        tools = [ctx.attr._manifest_tool[DefaultInfo].files_to_run],
        outputs = [output],
        env = {"LC_ALL": "C"},
        mnemonic = "WasixToolsEnvelope",
        progress_message = "Package declared portable WASIX tools %{label}",
    )
    return [DefaultInfo(files = depset([output])), merge_shipping_suppliers([
        ctx.attr.pg_dump[ShippingSupplierInfo], ctx.attr.psql[ShippingSupplierInfo],
    ])]

wasix_tools_payload = rule(
    implementation = _tools_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "pg_dump": attr.label(providers = [WasmModuleInfo, ShippingSupplierInfo], mandatory = True),
        "psql": attr.label(providers = [WasmModuleInfo, ShippingSupplierInfo], mandatory = True),
        "product": attr.label(default = "@oliphaunt_metadata//:product_postgres-tools-wasix", providers = [ReleaseIdentityInfo]),
        "runtime_product": attr.label(default = "@oliphaunt_metadata//:product_liboliphaunt-wasix", providers = [ReleaseIdentityInfo]),
        "patches": attr.label_list(allow_files = [".patch"], mandatory = True),
        "notices": attr.label_keyed_string_dict(default = RUNTIME_NPM_NOTICES, allow_files = True),
        "postgres_source": attr.label(default = "//src/third-party/postgres:source.toml", allow_single_file = True),
        "postgres_series": attr.label(default = "//src/wasix/runtime:postgres/series", allow_single_file = True),
        "icu_source": attr.label(default = "//src/third-party/icu:source.toml", allow_single_file = True),
        "_packager": attr.label(default = "//build_defs/wasix:tools.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = ["//build_defs/wasix:package.mts", "//:tools/packaging/archive-directory.mts", "//:tools/packaging/portable-archive.mts", "//:tools/packaging/release-notices.mts", "//:tools/packaging/release-directory-safety.mts"], allow_files = True),
        "_manifest_tool": attr.label(default = "//src/wasix/runtime/tools/xtask:xtask", executable = True, cfg = "exec"),
    },
)
