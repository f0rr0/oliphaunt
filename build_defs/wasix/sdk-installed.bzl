"""Original public SDK host contracts over its actual declared package tuple."""

load("@aspect_rules_js//npm:providers.bzl", "NpmPackageInfo")
load("@oliphaunt_metadata//:metadata.bzl", "COMPLETED_SUPPLIER_ARTIFACTS", "PREPARED_NATIVE_SELECTED_PRODUCTS", "PRODUCTS", "PUBLICATION_CARRIERS", "WASIX_ARTIFACTS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")

def _runfile(ctx, file):
    return file.short_path[3:] if file.short_path.startswith("../") else ctx.workspace_name + "/" + file.short_path

def _installed_impl(ctx):
    if ctx.attr.error:
        fail(ctx.attr.error)
    node = ctx.toolchains["@rules_nodejs//nodejs:toolchain_type"].nodeinfo.node
    if not node or not ctx.executable.deno or not ctx.executable.electron or not ctx.files.electron_runtime:
        fail("WASIX public SDK host contracts require pinned Node, Deno and complete Electron inputs")
    packages = []
    files = [ctx.file.sdk, ctx.file.runtime, ctx.file.addon, ctx.file.extension, ctx.file.fixture, ctx.file.pgwire, ctx.file._runner, node, ctx.executable.deno, ctx.executable.electron] + ctx.files.electron_runtime
    for target, name in ctx.attr.packages.items():
        package = target[NpmPackageInfo]
        if package.package != name or package.src.is_directory:
            fail("installed WASIX SDK requires its declared npm package archive: " + name)
        packages.append({"name": name, "version": package.version, "archive": _runfile(ctx, package.src)})
        files.append(package.src)
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({"packages": packages}))
    return bun_test_entrypoint(ctx, ctx.file._runner,
        [ctx.file.sdk, ctx.file.runtime, ctx.file.addon, ctx.file.extension, ctx.file.fixture, ctx.file.pgwire, node, ctx.executable.deno, ctx.executable.electron, spec],
        files + [spec] + ctx.files._helpers,
        source_files = [ctx.file._runner] + ctx.files._helpers,
        runfiles_environment = ["OLIPHAUNT_BAZEL_RUNFILES"])

_installed_test = rule(implementation = _installed_impl, test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS + ["@rules_nodejs//nodejs:toolchain_type"],
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "sdk": attr.label(mandatory = True, allow_single_file = [".tgz"]),
        "runtime": attr.label(allow_single_file = [".tgz"]),
        "addon": attr.label(allow_single_file = [".tgz"]),
        "extension": attr.label(mandatory = True, allow_single_file = [".tgz"]),
        "fixture": attr.label(mandatory = True, allow_single_file = [".mts"]),
        "pgwire": attr.label(mandatory = True, allow_single_file = [".mts"]),
        "packages": attr.label_keyed_string_dict(providers = [NpmPackageInfo]),
        "error": attr.string(),
        "deno": attr.label(executable = True, cfg = "exec", allow_files = True, mandatory = True),
        "electron": attr.label(executable = True, cfg = "exec", allow_files = True, mandatory = True),
        "electron_runtime": attr.label_list(cfg = "exec", allow_files = True, mandatory = True),
        "_runner": attr.label(default = "//build_defs/wasix:sdk-installed.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = ["//build_defs/wasix/browser:npm-archives.mts"], allow_files = True),
    }))

def _package_input(product, version, package_name, current):
    key = product + "/" + version + "/npm:" + package_name
    captured = COMPLETED_SUPPLIER_ARTIFACTS.get(key)
    if captured:
        return struct(archive = captured["file"]["path"], error = "")
    if product in PREPARED_NATIVE_SELECTED_PRODUCTS and PRODUCTS[product]["version"] == version:
        return struct(archive = current, error = "")
    return struct(archive = None, error = "installed WASIX SDK requires completed npm:" + package_name + "@" + version)

def wasix_sdk_installed_test(name, **kwargs):
    descriptor = PRODUCTS["oliphaunt-wasix-ts"]
    runtime_version = descriptor["compatibility_versions"]["liboliphaunt-wasix"]
    addon_version = descriptor["compatibility_versions"]["oliphaunt-wasix-napi"]
    runtime_rows = [row for row in PUBLICATION_CARRIERS if row["product"] == "liboliphaunt-wasix" and row["ecosystem"] == "npm" and "npm:" + row["name"] in PRODUCTS["liboliphaunt-wasix"]["registry_packages"]]
    addon_rows = [row for row in WASIX_ARTIFACTS if row["product"] == "oliphaunt-wasix-napi" and row["kind"] == "wasix-napi-addon" and row["target"] == "linux-x64-gnu"]
    if len(runtime_rows) != 1 or len(addon_rows) != 1:
        fail("WASIX SDK host contracts require canonical runtime and GNU x64 addon packages")
    runtime = _package_input("liboliphaunt-wasix", runtime_version, runtime_rows[0]["name"], "//src/wasix/runtime:npm")
    addon = _package_input("oliphaunt-wasix-napi", addon_version, addon_rows[0]["npm_package"], "//src/wasix/node-addon:npm_release_shipping_files")
    _installed_test(name = name, args = bun_test_entrypoint_args(name),
        runtime = runtime.archive, addon = addon.archive,
        error = runtime.error or addon.error,
        deno = "@deno_linux_x64//:deno", electron = "@electron_linux_x64//:electron", electron_runtime = ["@electron_linux_x64//:runtime_files"],
        **kwargs)
