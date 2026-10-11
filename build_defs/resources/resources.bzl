"""Declared resource construction; PostgreSQL seed bytes are intentionally unique."""

load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "BunScriptInfo", "bun_action", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("@oliphaunt_metadata//:metadata.bzl", "DATABASE_RESOURCE_ARTIFACTS", "DATABASE_RESOURCE_CONTRACT", "DATABASE_SEED_CARRIERS", "PRODUCTS", "PUBLICATION_CARRIERS")
load("@oliphaunt_javascript_metadata//:metadata.bzl", "JAVASCRIPT")
load("@aspect_rules_js//npm:providers.bzl", "NpmPackageInfo")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")

NativeSeedInfo = provider(fields = ["frozen", "abi", "runtime", "profile", "target"])
WasixSeedInfo = provider(fields = ["frozen", "runtime", "profile", "target"])
SeedAssetsInfo = provider(fields = ["archive", "manifest"])

_LINUX_X64 = ["@platforms//os:linux", "@platforms//cpu:x86_64"]
_VERSION = PRODUCTS["database-resources"]["version"]

def _resource_compile_data_impl(ctx):
    output = ctx.actions.declare_file(ctx.attr.out)
    ctx.actions.symlink(output = output, target_file = ctx.file.src)
    return [DefaultInfo(files = depset([output]))]

resource_compile_data = rule(implementation = _resource_compile_data_impl, attrs = {
    "src": attr.label(mandatory = True, allow_single_file = True),
    "out": attr.string(mandatory = True),
})

_NOTICES = [
    "//:LICENSE", "//:THIRD_PARTY_NOTICES.md",
    "//src/native/runtime:THIRD_PARTY_NOTICES.md",
    "//src/wasix/sdks/rust:THIRD_PARTY_NOTICES.md",
    "//src/third-party/postgres:COPYRIGHT", "//src/third-party/postgres:source.toml",
    "//src/third-party/icu:LICENSE", "//src/third-party/icu:source.toml",
]

def _input_map(files):
    return {file.short_path: file.path for file in files}

def _action(ctx, specification, inputs, outputs, mnemonic, **kwargs):
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode(specification) + "\n")
    arguments = ctx.actions.args()
    arguments.add(spec)
    bun_action(ctx, ctx.attr._tool, arguments = [arguments], inputs = inputs + [spec], outputs = outputs, mnemonic = mnemonic, **kwargs)

def _tool(label):
    return attr.label(default = Label(label), providers = [BunScriptInfo], cfg = "exec")

def _icu_payload_impl(ctx):
    _action(ctx, {
        "data": ctx.file.data.path,
        "output": ctx.outputs.out.path,
        "notices": _input_map(ctx.files.notices),
    }, [ctx.file.data] + ctx.files.notices, [ctx.outputs.out], "IcuResourceArchive")
    return [DefaultInfo(files = depset([ctx.outputs.out]))]

icu_payload = rule(implementation = _icu_payload_impl, attrs = {
    "data": attr.label(default = "@icu_data//:icudt76l.dat", allow_single_file = True),
    "notices": attr.label_list(default = _NOTICES, allow_files = True),
    "out": attr.output(mandatory = True),
    "_tool": _tool("//build_defs/resources:icu_payload"),
})

def _native_seed_impl(ctx):
    frozen = ctx.actions.declare_file(ctx.label.name + ".tar")
    abi = ctx.actions.declare_file(ctx.label.name + ".abi.properties")
    config = [file for file in ctx.files.configuration if file.basename == "pg_config.h"]
    if len(config) != 1:
        fail("seed ABI requires exactly one actual configured pg_config.h")
    headers = {"src/include/pg_config.h": config[0].path}
    for target, relative in ctx.attr.headers.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1:
            fail("seed ABI header must have exactly one declared file")
        headers[relative] = files[0].path
    _action(ctx, {
        "runtime": ctx.file.runtime.path,
        "profile": ctx.attr.profile,
        "target": ctx.attr.target,
        "contract": DATABASE_RESOURCE_CONTRACT,
        "headers": headers,
        "icu": ctx.file.icu.path if ctx.file.icu else None,
        "output": frozen.path,
        "abiOutput": abi.path,
    }, [ctx.file.runtime] + ctx.files.configuration + ctx.files.headers + ([ctx.file.icu] if ctx.file.icu else []), [frozen, abi], "PostgresClusterSeed")
    return [DefaultInfo(files = depset([frozen, abi])),
            NativeSeedInfo(frozen = frozen, abi = abi, runtime = ctx.file.runtime, profile = ctx.attr.profile, target = ctx.attr.target),
            OutputGroupInfo(frozen = depset([frozen]), abi = depset([abi]))]

native_seed = rule(implementation = _native_seed_impl, attrs = {
    "runtime": attr.label(default = "//src/native/runtime:runtime_payload", allow_single_file = True),
    "configuration": attr.label(default = "@postgres//:configuration", allow_files = True),
    "headers": attr.label_keyed_string_dict(default = {
        Label("@postgres//:src/include/pg_config_manual.h"): "src/include/pg_config_manual.h",
        Label("@postgres//:src/include/catalog/catversion.h"): "src/include/catalog/catversion.h",
        Label("@postgres//:src/include/catalog/pg_control.h"): "src/include/catalog/pg_control.h",
    }, allow_files = True),
    "profile": attr.string(values = ["standard", "icu"], mandatory = True),
    "target": attr.string(default = "linux-x64-gnu"),
    "icu": attr.label(allow_single_file = True),
    "_tool": _tool("//build_defs/resources:native_seed"),
})

def _wasix_resources(_os, _input_count):
    return {"cpu": 2, "memory": 8192}

def _wasix_seed_impl(ctx):
    frozen = ctx.actions.declare_file(ctx.label.name + ".tar")
    _action(ctx, {
        "runtime": ctx.file.runtime.path,
        "runner": ctx.executable._runner.path,
        "profile": ctx.attr.profile,
        "target": "portable",
        "icu": ctx.file.icu.path if ctx.file.icu else None,
        "output": frozen.path,
    }, [ctx.file.runtime] + ([ctx.file.icu] if ctx.file.icu else []), [frozen], "WasixClusterSeed",
            tools = [ctx.attr._runner[DefaultInfo].files_to_run], resource_set = _wasix_resources,
            env = {"LC_ALL": "C", "RAYON_NUM_THREADS": "2"})
    return [DefaultInfo(files = depset([frozen])),
            WasixSeedInfo(frozen = frozen, runtime = ctx.file.runtime, profile = ctx.attr.profile, target = "portable"),
            OutputGroupInfo(frozen = depset([frozen]))]

wasix_seed = rule(implementation = _wasix_seed_impl, attrs = {
    "runtime": attr.label(default = "//src/wasix/runtime:portable_payload", allow_single_file = True),
    "profile": attr.string(values = ["standard", "icu"], mandatory = True),
    "icu": attr.label(allow_single_file = True),
    "_tool": _tool("//build_defs/resources:wasix_seed"),
    "_runner": attr.label(default = "//src/database-resources/seeds/wasix:seed_runner", executable = True, cfg = "exec"),
})

def _seed_assets_impl(ctx):
    family = "native" if NativeSeedInfo in ctx.attr.seed else "wasix"
    seed = ctx.attr.seed[NativeSeedInfo] if family == "native" else ctx.attr.seed[WasixSeedInfo]
    _action(ctx, {
        "family": family,
        "seed": seed.frozen.path,
        "runtime": seed.runtime.path,
        "profile": seed.profile,
        "target": seed.target,
        "icu": ctx.file.icu.path if ctx.file.icu else None,
        "version": _VERSION,
        "runtimeVersion": PRODUCTS["liboliphaunt-" + family]["version"],
        "contract": DATABASE_RESOURCE_CONTRACT,
        "archive": ctx.outputs.archive.path,
        "manifest": ctx.outputs.manifest.path,
    }, [seed.frozen, seed.runtime] + ([seed.abi] if family == "native" else []) + ([ctx.file.icu] if ctx.file.icu else []), [ctx.outputs.archive, ctx.outputs.manifest], "ClusterSeedArchive")
    return [DefaultInfo(files = depset([ctx.outputs.archive, ctx.outputs.manifest])),
            SeedAssetsInfo(archive = ctx.outputs.archive, manifest = ctx.outputs.manifest),
            OutputGroupInfo(archive = depset([ctx.outputs.archive]), manifest = depset([ctx.outputs.manifest]))]

seed_assets = rule(implementation = _seed_assets_impl, attrs = {
    "seed": attr.label(providers = [[NativeSeedInfo], [WasixSeedInfo]], mandatory = True),
    "icu": attr.label(allow_single_file = True),
    "archive": attr.output(mandatory = True),
    "manifest": attr.output(mandatory = True),
    "_tool": _tool("//build_defs/resources:seed_assets"),
})

def _resource_carriers_impl(ctx):
    npm = ctx.actions.declare_file(ctx.label.name + ".tgz")
    cargo = ctx.actions.declare_file(ctx.label.name + ".crate")
    maven = ctx.actions.declare_directory(ctx.label.name + "/maven") if ctx.attr.kind == "icu" or ctx.attr.target == "android-datum64" else None
    templates = {}
    for target, relative in ctx.attr.templates.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1:
            fail("resource template must name one authored file")
        templates[relative] = files[0].path
    _action(ctx, {
        "kind": ctx.attr.kind,
        "family": ctx.attr.family,
        "target": ctx.attr.target,
        "profile": ctx.attr.profile,
        "version": _VERSION,
        "contract": DATABASE_RESOURCE_CONTRACT,
        "carriers": json.decode(ctx.attr.carriers),
        "artifactRows": DATABASE_RESOURCE_ARTIFACTS,
        "assets": [file.path for file in ctx.files.assets],
        "templates": templates,
        "notices": _input_map(ctx.files.notices),
        "npmOutput": npm.path,
        "cargoOutput": cargo.path,
        "mavenOutput": maven.path if maven else None,
    }, ctx.files.assets + ctx.files.templates + ctx.files.notices, [npm, cargo] + ([maven] if maven else []), "ResourceCarriers")
    return [DefaultInfo(files = depset([npm, cargo] + ([maven] if maven else []))),
            OutputGroupInfo(npm = depset([npm]), cargo = depset([cargo]), maven = depset([maven] if maven else []))]

resource_carriers = rule(implementation = _resource_carriers_impl, attrs = {
    "assets": attr.label_list(allow_files = True, mandatory = True),
    "templates": attr.label_keyed_string_dict(allow_files = True),
    "notices": attr.label_list(default = _NOTICES, allow_files = True),
    "kind": attr.string(values = ["icu", "seed"], mandatory = True),
    "family": attr.string(default = "native", values = ["native", "wasix"]),
    "target": attr.string(default = "portable"),
    "profile": attr.string(),
    "carriers": attr.string(mandatory = True),
    "_tool": _tool("//build_defs/resources:carriers"),
})

def _rows(names):
    rows = [row for row in PUBLICATION_CARRIERS if row["product"] == "database-resources" and row["name"] in names]
    if len(rows) != len(names):
        fail("resource carriers must exactly match the canonical publication catalog")
    return rows

def _shipping(name, rows):
    packages = []
    for row in rows:
        label = name + "_" + row["ecosystem"]
        native.filegroup(name = label + "_files", srcs = [":" + name], output_group = row["ecosystem"])
        shipping_package(name = label, owner = "@oliphaunt_metadata//:product_database-resources", artifacts = [":" + label + "_files"],
                         ecosystem = row["ecosystem"], package_name = row["name"], configuration = row["target"] or "portable", role = row["role"])
        packages.append(":" + label)
    return packages

def seed_envelopes(prefix, family, target, profile, seed, icu = None, compatible = []):
    """Use the one canonical row expansion and existing writers for one seed."""
    rows = [row for row in DATABASE_RESOURCE_ARTIFACTS if row["kind"] == family + "-seeds" and row["target"] == target and ("." + profile + ".") in row["id"]]
    archives = [row for row in rows if row["asset"].endswith(".tar.zst")]
    manifests = [row for row in rows if row["asset"].endswith(".json")]
    if len(archives) != 1 or len(manifests) != 1:
        fail("seed envelopes require exactly the canonical archive and manifest")
    archive, manifest = archives[0], manifests[0]
    seed_assets(name = prefix + "_assets", seed = seed, icu = icu,
                archive = archive["asset"].replace("{version}", _VERSION), manifest = manifest["asset"].replace("{version}", _VERSION), target_compatible_with = compatible)
    packages = []
    for group, row in [("archive", archive), ("manifest", manifest)]:
        native.filegroup(name = prefix + "_" + group, srcs = [":" + prefix + "_assets"], output_group = group)
        shipping_package(name = prefix + "_github_" + group, owner = "@oliphaunt_metadata//:product_database-resources", artifacts = [":" + prefix + "_" + group],
                         ecosystem = "github", package_name = row["asset"].replace("{version}", _VERSION), configuration = row["target"], role = "github-release-asset")
        packages.append(":" + prefix + "_github_" + group)
    identities = [row for row in DATABASE_SEED_CARRIERS if row["family"] == family and row["target"] == target and row["profile"] == profile]
    if len(identities) != 1:
        fail("seed envelopes require one canonical registry identity")
    identity = identities[0]
    names = [identity["npm"], identity["cargo"]]
    if target == "android-datum64":
        maven = [row for row in PUBLICATION_CARRIERS if row["product"] == "database-resources" and row["ecosystem"] == "maven" and row["name"].split(":")[-1] == identity["cargo"]]
        if len(maven) != 1:
            fail("Android seed requires exactly its declared canonical Maven carrier")
        names.append(maven[0]["name"])
    carriers = _rows(names)
    resource_carriers(name = prefix + "_carriers", kind = "seed", family = family, target = target, profile = profile, assets = [":" + prefix + "_assets"] + ([icu] if target == "android-datum64" and profile == "icu" else []), carriers = json.encode(carriers), target_compatible_with = compatible)
    packages.extend(_shipping(prefix + "_carriers", carriers))
    return packages

def native_seed_envelopes(prefix, target, profile, seed, icu = None, compatible = []):
    return seed_envelopes(prefix, "native", target, profile, seed, icu, compatible)

def wasix_resource_slice(name):
    packages = []
    for profile in DATABASE_RESOURCE_CONTRACT["profiles"]:
        prefix = "wasix_" + profile
        icu = ":icu_payload" if profile == "icu" else None
        wasix_seed(name = prefix + "_seed", profile = profile, icu = icu,
                   target_compatible_with = _LINUX_X64,
                   exec_compatible_with = _LINUX_X64 + ["@zig_sdk//libc:gnu.2.34"])
        native.filegroup(name = prefix + "_frozen", srcs = [":" + prefix + "_seed"], output_group = "frozen")
        packages.extend(seed_envelopes(prefix, "wasix", "portable", profile, ":" + prefix + "_seed", icu = icu, compatible = _LINUX_X64))
    shipping_export(name = name, packages = packages)

def _wasix_resource_test_impl(ctx):
    arguments = [ctx.executable._unit_test, ctx.executable._runner, ctx.file.runtime, ctx.file.icu, _VERSION, PRODUCTS["liboliphaunt-wasix"]["version"]]
    files = [ctx.executable._unit_test, ctx.executable._runner, ctx.file.runtime, ctx.file.icu]
    for profile in ["standard", "icu"]:
        frozen = getattr(ctx.file, profile + "_frozen")
        assets = getattr(ctx.files, profile + "_assets")
        carriers = getattr(ctx.files, profile + "_carriers")
        archives = [file for file in assets if file.basename.endswith(".tar.zst")]
        manifests = [file for file in assets if file.basename.endswith(".json")]
        npm = [file for file in carriers if file.basename.endswith(".tgz")]
        cargo = [file for file in carriers if file.basename.endswith(".crate")]
        if [len(archives), len(manifests), len(npm), len(cargo)] != [1, 1, 1, 1]:
            fail("WASIX resource test requires one actual archive/manifest/npm/Cargo for each profile")
        selected = [frozen, archives[0], manifests[0], npm[0], cargo[0]]
        arguments.extend(selected)
        files.extend(selected)
    fzstd = ctx.attr._fzstd[NpmPackageInfo].src
    arguments.append(fzstd)
    files.append(fzstd)
    for label, relative in ctx.attr._sdk_helpers.items():
        sources = label[DefaultInfo].files.to_list()
        if len(sources) != 1:
            fail("SDK resource consumer helper must be exactly one authored File")
        arguments.extend([relative, sources[0]])
        files.extend(sources)
    identities = [row for row in DATABASE_SEED_CARRIERS if row["family"] == "wasix"]
    arguments.append(json.encode(identities))
    return bun_test_entrypoint(ctx, ctx.file._script, arguments, files + ctx.files._helpers,
                              source_files = [ctx.file._script] + ctx.files._helpers,
                              additional_runfiles = ctx.attr._runner[DefaultInfo].default_runfiles.merge(ctx.attr._unit_test[DefaultInfo].default_runfiles))

_wasix_resource_test = rule(implementation = _wasix_resource_test_impl, test = True, toolchains = BUN_SOURCE_TOOLCHAINS,
                          attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
    "runtime": attr.label(default = "//src/wasix/runtime:portable_payload", allow_single_file = True),
    "icu": attr.label(default = "//src/database-resources:icu_payload", allow_single_file = True),
    "standard_frozen": attr.label(default = "//src/database-resources:wasix_standard_frozen", allow_single_file = True),
    "standard_assets": attr.label(default = "//src/database-resources:wasix_standard_assets"),
    "standard_carriers": attr.label(default = "//src/database-resources:wasix_standard_carriers"),
    "icu_frozen": attr.label(default = "//src/database-resources:wasix_icu_frozen", allow_single_file = True),
    "icu_assets": attr.label(default = "//src/database-resources:wasix_icu_assets"),
    "icu_carriers": attr.label(default = "//src/database-resources:wasix_icu_carriers"),
    "_runner": attr.label(default = "//src/database-resources/seeds/wasix:seed_runner", executable = True, cfg = "exec"),
    "_unit_test": attr.label(default = "//src/database-resources/seeds/wasix:unit_test", executable = True, cfg = "exec"),
    "_script": attr.label(default = "//build_defs/resources:wasix_resource.test.mts", allow_single_file = True),
    "_fzstd": attr.label(default = Label("@javascript_packages//:" + JAVASCRIPT["@oliphaunt/wasix-ts"]["packages"]["fzstd"]), providers = [NpmPackageInfo]),
    "_sdk_helpers": attr.label_keyed_string_dict(default = {
        Label("//src/wasix/sdks/ts:src/resources/extensions.ts"): "resources/extensions.ts",
        Label("//src/wasix/sdks/ts:src/resources/archive.ts"): "resources/archive.ts",
        Label("//src/wasix/sdks/ts:src/resources/asset-source.ts"): "resources/asset-source.ts",
        Label("//src/wasix/sdks/ts:src/resources/zstd.ts"): "resources/zstd.ts",
        Label("//src/wasix/sdks/ts:src/storage/database-root.ts"): "storage/database-root.ts",
    }, allow_files = True),
    "_helpers": attr.label_list(default = ["//build_defs/resources:helpers"], allow_files = True),
}))

def wasix_resource_test(name):
    _wasix_resource_test(name = name, args = bun_test_entrypoint_args(name), size = "large", timeout = "long",
                         target_compatible_with = _LINUX_X64,
                         exec_compatible_with = _LINUX_X64 + ["@zig_sdk//libc:gnu.2.34"])

def linux_resource_slice(name, templates):
    icu_row = [row for row in DATABASE_RESOURCE_ARTIFACTS if row["kind"] == "icu-data"][0]
    icu_payload(name = "icu_payload", out = icu_row["asset"].replace("{version}", _VERSION))
    icu_rows = _rows(["@oliphaunt/icu", "oliphaunt-icu", "dev.oliphaunt.runtime:oliphaunt-icu"])
    resource_carriers(name = "icu_carriers", kind = "icu", assets = [":icu_payload"], templates = templates, carriers = json.encode(icu_rows))
    packages = _shipping("icu_carriers", icu_rows)
    shipping_package(name = "icu_github", owner = "@oliphaunt_metadata//:product_database-resources", artifacts = [":icu_payload"], ecosystem = "github",
                     package_name = icu_row["asset"].replace("{version}", _VERSION), configuration = "portable", role = "github-release-asset")
    packages.append(":icu_github")
    for profile in DATABASE_RESOURCE_CONTRACT["profiles"]:
        prefix = "linux_x64_" + profile
        native_seed(name = prefix + "_seed", profile = profile, icu = ":icu_payload" if profile == "icu" else None, target_compatible_with = _LINUX_X64)
        native.filegroup(name = prefix + "_frozen", srcs = [":" + prefix + "_seed"], output_group = "frozen")
        native.filegroup(name = prefix + "_abi", srcs = [":" + prefix + "_seed"], output_group = "abi")
        packages.extend(native_seed_envelopes(prefix, "linux-x64-gnu", profile, ":" + prefix + "_seed", icu = ":icu_payload" if profile == "icu" else None, compatible = _LINUX_X64))
    shipping_export(name = name, packages = packages)
