"""Execute the source-owned SDK unit suites without native runtime construction."""

load("@aspect_rules_js//npm:providers.bzl", "NpmPackageInfo")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")

def _runfile(ctx, file):
    return file.short_path[3:] if file.short_path.startswith("../") else ctx.workspace_name + "/" + file.short_path

def _sdk_unit_test_impl(ctx):
    sources = {}
    for file in ctx.files.sources + ctx.files.fixtures + ctx.files.tests + ctx.files.package_manifests + [ctx.file.manifest] + ([ctx.file.configuration] if ctx.file.configuration else []):
        if file.is_directory or file.short_path.startswith("../"):
            fail("SDK source units require individual repository source Files")
        if file.short_path in sources and sources[file.short_path] != file:
            fail("SDK source units have conflicting declared source paths: " + file.short_path)
        sources[file.short_path] = file
    packages = []
    package_files = []
    for target, name in ctx.attr.packages.items():
        package = target[NpmPackageInfo]
        if package.package != name or package.src.is_directory:
            fail("SDK source units require the declared npm archive identity for " + name)
        packages.append({"name": name, "version": package.version, "archive": _runfile(ctx, package.src)})
        package_files.append(package.src)
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode({
        "sdk": ctx.file.manifest.short_path.removesuffix("/package.json"),
        "sources": {relative: _runfile(ctx, file) for relative, file in sources.items()},
        "configuration": ctx.file.configuration.short_path if ctx.file.configuration else None,
        "packageManifests": [file.short_path for file in ctx.files.package_manifests],
        "tests": sorted([file.short_path for file in ctx.files.tests]) if ctx.files.tests else sorted([relative for relative in sources if relative.startswith(ctx.file.manifest.short_path.removesuffix("package.json") + "src/__tests__/") and relative.endswith(".test.ts")]),
        "packages": packages,
    }))
    return bun_test_entrypoint(ctx, ctx.file._runner, [specification],
        [specification] + sources.values() + package_files + [ctx.file._runner],
        source_files = [ctx.file._runner], runfiles_environment = ["OLIPHAUNT_BAZEL_RUNFILES"])

_sdk_unit_test = rule(
    implementation = _sdk_unit_test_impl,
    test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "manifest": attr.label(mandatory = True, allow_single_file = [".json"]),
        "sources": attr.label_list(allow_files = True, mandatory = True),
        "tests": attr.label_list(allow_files = [".test.ts", ".test.mts"], doc = "Optional existing SDK-owned operational test roots; source suites use their conventional src/__tests__ tree."),
        "fixtures": attr.label_list(allow_files = True),
        "configuration": attr.label(allow_single_file = [".toml"]),
        "package_manifests": attr.label_list(allow_files = [".json"], doc = "Authored metadata for existing unit-owned carrier fixtures; no native payload construction."),
        "packages": attr.label_keyed_string_dict(providers = [NpmPackageInfo]),
        "_runner": attr.label(default = "//build_defs/languages/ts:unit-tests.mts", allow_single_file = True),
    }),
)

def sdk_unit_test(name, **kwargs):
    _sdk_unit_test(name = name, args = bun_test_entrypoint_args(name), **kwargs)
