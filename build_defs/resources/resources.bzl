"""Declared resource construction; PostgreSQL seed bytes are intentionally unique."""

load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "BunScriptInfo", "bun_action", "bun_script_test", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/host:desktop-profile.bzl", "desktop_profile")
load("@oliphaunt_metadata//:metadata.bzl", "DATABASE_RESOURCE_ARTIFACTS", "DATABASE_RESOURCE_CONTRACT", "DATABASE_WASIX_SEED_CONSUMER", "DATABASE_SEED_CARRIERS", "NATIVE_RUNTIME_ARTIFACTS", "PRODUCTS", "PUBLICATION_CARRIERS", "SEED_REUSE_CONTROLS", "COMPLETED_SUPPLIER_ARTIFACTS", "WASIX_ARTIFACTS")
load("@oliphaunt_javascript_metadata//:metadata.bzl", "JAVASCRIPT")
load("@aspect_rules_js//npm:providers.bzl", "NpmPackageInfo")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")
load("//build_defs/release:supplier.bzl", "file_shipping_supplier")
load("//build_defs/native:platform_config.bzl", "NATIVE_COMPATIBLE")

NativeSeedInfo = provider(fields = ["frozen", "abi", "runtime", "profile", "target", "construction"])
WasixSeedInfo = provider(fields = ["frozen", "runtime", "profile", "target", "construction"])
SeedAssetsInfo = provider(fields = ["archive", "manifest"])

_LINUX_X64 = ["@platforms//os:linux", "@platforms//cpu:x86_64"]
_DESKTOP_PROFILES = {
    "linux_x64": ("linux-x64-gnu", _LINUX_X64, "//build_defs/native:linux_x86_64"),
    "linux_arm64": ("linux-arm64-gnu", ["@platforms//os:linux", "@platforms//cpu:aarch64"], "//build_defs/native:linux_aarch64"),
    "macos_arm64": ("macos-arm64", ["@platforms//os:macos", "@platforms//cpu:aarch64"], "//build_defs/native:macos_arm64"),
    "windows_x64": ("windows-x64-msvc", ["@platforms//os:windows", "@platforms//cpu:x86_64"], "//build_defs/native:windows_x64"),
}
_VERSION = PRODUCTS["database-resources"]["version"]

def _wasix_consumer_version():
    return PRODUCTS["database-resources"]["compatibility_versions"]["liboliphaunt-wasix"]

def _wasix_consumer():
    version = _wasix_consumer_version()
    rows = [row for row in WASIX_ARTIFACTS if row["product"] == "liboliphaunt-wasix" and row["kind"] == "wasix-runtime" and row["target"] == "portable"]
    if len(rows) != 1:
        fail("WASIX seed consumer requires one canonical portable archive")
    artifact = "github-release:" + rows[0]["asset"].replace("{version}", version)
    key = "liboliphaunt-wasix/" + version + "/" + artifact
    return COMPLETED_SUPPLIER_ARTIFACTS.get(key)


def _runtime_artifact(target):
    rows = [row for row in NATIVE_RUNTIME_ARTIFACTS
            if row["product"] == "liboliphaunt-native" and row["kind"] == "native-runtime" and row["target"] == target]
    if len(rows) != 1:
        fail("native seed must consume exactly one canonical runtime artifact for " + target)
    return {key: rows[0][key] for key in ["target", "npm_os", "npm_cpu", "library_relative_path"]}

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

def _action(ctx, specification, inputs, outputs, mnemonic, tree_inputs = None, **kwargs):
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode(specification) + "\n")
    arguments = ctx.actions.args()
    arguments.add(spec)
    action_arguments = [arguments]
    if tree_inputs != None:
        tree_arguments = ctx.actions.args()
        tree_arguments.add_all(depset(tree_inputs), expand_directories = True)
        tree_arguments.use_param_file("--construction-tree-files=%s", use_always = True)
        tree_arguments.set_param_file_format("multiline")
        action_arguments.append(tree_arguments)
    bun_action(ctx, ctx.attr._tool, arguments = action_arguments, inputs = inputs + [spec], outputs = outputs, mnemonic = mnemonic, **kwargs)
    return spec

def _tool(label):
    return attr.label(default = Label(label), providers = [BunScriptInfo], cfg = "exec")

def seed_constructor_inputs(ctx, inputs, logical_roles = {}):
    script = ctx.attr._tool[BunScriptInfo]
    files = inputs + script.files.to_list() + [script.bun]
    paths = {}
    for file in files:
        name = logical_roles.get(file.path) or ("external/" + file.short_path[3:] if file.short_path.startswith("../") else file.short_path)
        if name in paths and paths[name] != file.path:
            fail("Seed construction inputs share a logical File name: " + name)
        paths[name] = file.path
    return paths

def seed_constructor_tree_members(ctx):
    """The Bun provider owns the exact regular Files copied into its code trees."""
    sources = ctx.attr._tool[BunScriptInfo].sources
    return {
        ("external/" + tree.short_path[3:] if tree.short_path.startswith("../") else tree.short_path): {
            name.removeprefix(repository + "/"): file.path
            for name, file in sources.members.items()
            if name.startswith(repository + "/")
        }
        for repository, tree in sources.trees.items()
    }

SEED_REUSE_ATTRS = {
    "completed_archive": attr.label(allow_single_file = True),
    "completed_manifest": attr.label(allow_single_file = True),
    "completed_metadata": attr.label(allow_single_file = True),
    "completed_anchor": attr.label(allow_single_file = True),
    "reuse_control": attr.string(),
    "qualified_frozen": attr.label(allow_single_file = True),
    "qualified_receipt": attr.label(allow_single_file = True),
    "promotion_control": attr.string(),
}

def seed_reuse(ctx):
    inputs = [file for file in [ctx.file.completed_archive, ctx.file.completed_manifest, ctx.file.completed_metadata, ctx.file.completed_anchor] if file]
    if not ctx.attr.reuse_control:
        if inputs:
            fail("Completed seed Files require their exact typed origin control")
        return None, []
    if not ctx.file.completed_archive or not ctx.file.completed_manifest:
        fail("Seed reuse requires both actual completed archive and descriptor Files")
    control = json.decode(ctx.attr.reuse_control)
    control["archive"]["path"] = ctx.file.completed_archive.path
    control["manifest"]["path"] = ctx.file.completed_manifest.path
    if ctx.file.completed_metadata:
        control["metadata"]["path"] = ctx.file.completed_metadata.path
    elif control.get("metadata"):
        fail("Seed metadata origin must name its actual declared File")
    if ctx.file.completed_anchor:
        control["anchor"]["path"] = ctx.file.completed_anchor.path
    elif control.get("anchor"):
        fail("Seed migration anchor must name its actual declared File")
    return control, inputs

def seed_promotion(ctx):
    inputs = [file for file in [ctx.file.qualified_frozen, ctx.file.qualified_receipt] if file]
    if not ctx.attr.promotion_control:
        if inputs:
            fail("Qualified seed Files require their exact original producer and transition")
        return None, []
    if ctx.attr.reuse_control or not ctx.file.qualified_frozen or not ctx.file.qualified_receipt:
        fail("Seed promotion requires exactly its original frozen TAR and receipt Files")
    control = json.decode(ctx.attr.promotion_control)
    control["frozen"]["path"] = ctx.file.qualified_frozen.path
    control["receipt"]["path"] = ctx.file.qualified_receipt.path
    return control, inputs

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
    construction = ctx.actions.declare_file(ctx.label.name + ".seed-construction.json")
    config = [file for file in ctx.files.configuration if file.basename == "pg_config.h"]
    if len(config) != 1:
        fail("seed ABI requires exactly one actual configured pg_config.h")
    headers = {"src/include/pg_config.h": config[0].path}
    for target, relative in ctx.attr.headers.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1:
            fail("seed ABI header must have exactly one declared file")
        headers[relative] = files[0].path
    constructor_inputs = [ctx.file.runtime] + ctx.files.configuration + ctx.files.headers + ([ctx.file.icu] if ctx.file.icu else [])
    reuse, reuse_inputs = seed_reuse(ctx)
    promotion, promotion_inputs = seed_promotion(ctx)
    specification = _action(ctx, {
        "runtime": ctx.file.runtime.path,
        "profile": ctx.attr.profile,
        "target": ctx.attr.target,
        "runtimeArtifact": _runtime_artifact(ctx.attr.target),
        "contract": DATABASE_RESOURCE_CONTRACT,
        "headers": headers,
        "icu": ctx.file.icu.path if ctx.file.icu else None,
        "output": frozen.path,
        "abiOutput": abi.path,
        "constructionInputs": seed_constructor_inputs(ctx, constructor_inputs),
        "constructionTreeMembers": seed_constructor_tree_members(ctx),
        "constructionOutput": construction.path,
        "reuse": reuse,
        "promotion": promotion,
    }, constructor_inputs + reuse_inputs + promotion_inputs, [frozen, abi, construction], "PostgresClusterSeed")
    return [DefaultInfo(files = depset([frozen, abi, construction])),
            NativeSeedInfo(frozen = frozen, abi = abi, runtime = ctx.file.runtime, profile = ctx.attr.profile, target = ctx.attr.target, construction = construction),
            OutputGroupInfo(frozen = depset([frozen]), abi = depset([abi]), specification = depset([specification]), construction = depset([construction]), observation_inputs = depset([frozen, construction]))]

native_seed = rule(implementation = _native_seed_impl, cfg = desktop_profile, attrs = dict(SEED_REUSE_ATTRS, **{
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
    "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
}))

def _wasix_resources(_os, _input_count):
    return {"cpu": 2, "memory": 8192}

def _wasix_seed_impl(ctx):
    frozen = ctx.actions.declare_file(ctx.label.name + ".tar")
    construction = ctx.actions.declare_file(ctx.label.name + ".seed-construction.json")
    constructor_inputs = [ctx.file.runtime] + ([ctx.file.icu] if ctx.file.icu else []) + ctx.attr._runner[DefaultInfo].files.to_list() + ctx.attr._runner[DefaultInfo].default_runfiles.files.to_list()
    constructor_trees = [file for file in constructor_inputs if file.is_directory]
    reuse, reuse_inputs = seed_reuse(ctx)
    promotion, promotion_inputs = seed_promotion(ctx)
    _action(ctx, {
        "runtime": ctx.file.runtime.path,
        "runner": ctx.executable._runner.path,
        "profile": ctx.attr.profile,
        "target": "portable",
        "icu": ctx.file.icu.path if ctx.file.icu else None,
        "output": frozen.path,
        "contract": DATABASE_RESOURCE_CONTRACT,
        "constructionInputs": seed_constructor_inputs(ctx, constructor_inputs),
        "constructionTreeMembers": seed_constructor_tree_members(ctx),
        "constructionTrees": [file.path for file in depset(constructor_trees).to_list()],
        "constructionOutput": construction.path,
        "reuse": reuse,
        "promotion": promotion,
    }, constructor_inputs + reuse_inputs + promotion_inputs, [frozen, construction], "WasixClusterSeed",
            tree_inputs = constructor_trees,
            tools = [ctx.attr._runner[DefaultInfo].files_to_run], resource_set = _wasix_resources,
            env = {"LC_ALL": "C", "RAYON_NUM_THREADS": "2"})
    return [DefaultInfo(files = depset([frozen, construction])),
            WasixSeedInfo(frozen = frozen, runtime = ctx.file.runtime, profile = ctx.attr.profile, target = "portable", construction = construction),
            OutputGroupInfo(frozen = depset([frozen]), construction = depset([construction]), observation_inputs = depset([frozen, construction]))]

wasix_seed = rule(implementation = _wasix_seed_impl, attrs = dict(SEED_REUSE_ATTRS, **{
    "runtime": attr.label(default = "//src/wasix/runtime:portable_payload", allow_single_file = True),
    "profile": attr.string(values = ["standard", "icu"], mandatory = True),
    "icu": attr.label(allow_single_file = True),
    "_tool": _tool("//build_defs/resources:wasix_seed"),
    "_runner": attr.label(default = "//src/database-resources/seeds/wasix:seed_runner", executable = True, cfg = "exec"),
}))

def _seed_assets_impl(ctx):
    family = "native" if NativeSeedInfo in ctx.attr.seed else "wasix"
    seed = ctx.attr.seed[NativeSeedInfo] if family == "native" else ctx.attr.seed[WasixSeedInfo]
    if ctx.attr.consumer_version and (family != "wasix" or not ctx.attr.testonly):
        fail("an explicit seed consumer version requires private WASIX qualification")
    _action(ctx, {
        "family": family,
        "seed": seed.frozen.path,
        "construction": seed.construction.path,
        "runtime": ctx.file.consumer_runtime.path if family == "wasix" else None,
        "profile": seed.profile,
        "target": seed.target,
        "icu": ctx.file.icu.path if ctx.file.icu else None,
        "version": _VERSION,
        "runtimeVersion": (ctx.attr.consumer_version or _wasix_consumer_version()) if family == "wasix" else PRODUCTS["liboliphaunt-native"]["version"],
        "contract": DATABASE_RESOURCE_CONTRACT,
        "archive": ctx.outputs.archive.path,
        "manifest": ctx.outputs.manifest.path,
    }, [seed.frozen, seed.construction] + ([ctx.file.consumer_runtime] if family == "wasix" else []) + ([seed.abi] if family == "native" else []) + ([ctx.file.icu] if ctx.file.icu else []), [ctx.outputs.archive, ctx.outputs.manifest], "ClusterSeedArchive")
    return [DefaultInfo(files = depset([ctx.outputs.archive, ctx.outputs.manifest])),
            SeedAssetsInfo(archive = ctx.outputs.archive, manifest = ctx.outputs.manifest),
            OutputGroupInfo(archive = depset([ctx.outputs.archive]), manifest = depset([ctx.outputs.manifest]))]

seed_assets = rule(implementation = _seed_assets_impl, attrs = {
    "seed": attr.label(providers = [[NativeSeedInfo], [WasixSeedInfo]], mandatory = True),
    "consumer_runtime": attr.label(allow_single_file = True),
    "consumer_version": attr.string(doc = "Explicit WASIX consuming runtime version; omission retains public resource admission."),
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

def _shipping(name, rows, suppliers = None, observation_inputs = [], **kwargs):
    packages = []
    for row in rows:
        label = name + "_" + row["ecosystem"]
        native.filegroup(name = label + "_files", srcs = [":" + name], output_group = row["ecosystem"], **kwargs)
        shipping_package(name = label, owner = "@oliphaunt_metadata//:product_database-resources", artifacts = [":" + label + "_files"],
                         ecosystem = row["ecosystem"], package_name = row["name"], configuration = row["target"] or "portable", role = row["role"], suppliers = suppliers, observation_inputs = observation_inputs, **kwargs)
        packages.append(":" + label)
    return packages

def _seed_artifact_rows(family, target, profile):
    rows = [row for row in DATABASE_RESOURCE_ARTIFACTS if row["kind"] == family + "-seeds" and row["target"] == target and ("." + profile + ".") in row["id"]]
    archives = [row for row in rows if row["asset"].endswith(".tar.zst")]
    manifests = [row for row in rows if row["asset"].endswith(".json")]
    if len(archives) != 1 or len(manifests) != 1:
        fail("seed envelopes require exactly the canonical archive and manifest")
    return archives[0], manifests[0]

def wasix_current_seed_assets(name, profile = "standard"):
    """Private current-module admission preserves the original seed and creator."""
    archive, manifest = _seed_artifact_rows("wasix", "portable", profile)
    seed_assets(name = name, seed = "//src/database-resources:wasix_" + profile + "_seed",
                icu = "//src/database-resources:icu_payload" if profile == "icu" else None,
                consumer_runtime = "//src/wasix/runtime:portable_payload", consumer_version = PRODUCTS["liboliphaunt-wasix"]["version"],
                archive = name + "/" + archive["asset"].replace("{version}", _VERSION), manifest = name + "/" + manifest["asset"].replace("{version}", _VERSION),
                target_compatible_with = _LINUX_X64, testonly = True)
    for group in ["archive", "manifest"]:
        native.filegroup(name = name + "_" + group, srcs = [":" + name], output_group = group, testonly = True)

def seed_envelopes(prefix, family, target, profile, seed, icu = None, compatible = [], consumer_runtime = None, suppliers = None, **kwargs):
    """Use the one canonical row expansion and existing writers for one seed."""
    archive, manifest = _seed_artifact_rows(family, target, profile)
    seed_assets(name = prefix + "_assets", seed = seed, icu = icu, consumer_runtime = consumer_runtime,
                archive = archive["asset"].replace("{version}", _VERSION), manifest = manifest["asset"].replace("{version}", _VERSION), target_compatible_with = compatible, **kwargs)
    packages = []
    for group, row in [("archive", archive), ("manifest", manifest)]:
        native.filegroup(name = prefix + "_" + group, srcs = [":" + prefix + "_assets"], output_group = group, **kwargs)
        shipping_package(name = prefix + "_github_" + group, owner = "@oliphaunt_metadata//:product_database-resources", artifacts = [":" + prefix + "_" + group],
                         ecosystem = "github", package_name = row["asset"].replace("{version}", _VERSION), configuration = row["target"], role = "github-release-asset", suppliers = suppliers, observation_inputs = [seed], **kwargs)
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
    resource_carriers(name = prefix + "_carriers", kind = "seed", family = family, target = target, profile = profile, assets = [":" + prefix + "_assets"] + ([icu] if target in ["android-datum64", "ios-datum64"] and profile == "icu" else []), carriers = json.encode(carriers), target_compatible_with = compatible, **kwargs)
    packages.extend(_shipping(prefix + "_carriers", carriers, suppliers = suppliers, observation_inputs = [seed], **kwargs))
    return packages

def native_seed_envelopes(prefix, target, profile, seed, icu = None, compatible = []):
    return seed_envelopes(prefix, "native", target, profile, seed, icu, compatible)

def wasix_resource_slice(name, qualification):
    consumer = _wasix_consumer() if DATABASE_WASIX_SEED_CONSUMER["source"] == "completed" else None
    file_shipping_supplier(name = "wasix_consumer_supplier", inputs = {"//src/wasix/runtime:release_archive_portable": ""} if DATABASE_WASIX_SEED_CONSUMER["source"] == "current" else ({consumer["file"]["path"]: ""} if consumer else {}),
        owner = "@oliphaunt_metadata//:product_liboliphaunt-wasix", configuration = "portable", binding = "abi-contract",
        origin = json.encode({"kind": "current-source"}) if DATABASE_WASIX_SEED_CONSUMER["source"] == "current" else (json.encode({"kind": "completed-publication", "publication": consumer["publication"], "artifact": consumer["artifact"]}) if consumer else ""))
    packages = []
    for profile in DATABASE_RESOURCE_CONTRACT["profiles"]:
        prefix = "wasix_" + profile
        icu = ":icu_payload" if profile == "icu" else None
        wasix_seed(name = prefix + "_seed", profile = profile, icu = icu,
                   target_compatible_with = _LINUX_X64,
                   exec_compatible_with = _LINUX_X64 + ["@zig_sdk//libc:gnu.2.34"],
                   **SEED_REUSE_CONTROLS.get("wasix/portable/" + profile, {}))
        native.filegroup(name = prefix + "_frozen", srcs = [":" + prefix + "_seed"], output_group = "frozen")
        native.filegroup(name = prefix + "_construction", srcs = [":" + prefix + "_seed"], output_group = "construction")
        packages.extend(seed_envelopes(prefix, "wasix", "portable", profile, ":" + prefix + "_seed", icu = icu, compatible = _LINUX_X64, consumer_runtime = ":wasix_consumer_supplier", suppliers = ":wasix_consumer_supplier"))
    shipping_export(name = name, packages = packages, qualification = qualification, testonly = True)

def _wasix_resource_test_impl(ctx):
    arguments = [ctx.executable._unit_test, ctx.executable._runner, ctx.file.runtime, ctx.file.icu, _VERSION, _wasix_consumer_version()]
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
        selected = [frozen, archives[0], manifests[0], npm[0], cargo[0], getattr(ctx.file, profile + "_construction")]
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
    "runtime": attr.label(mandatory = True, allow_single_file = True),
    "icu": attr.label(default = "//src/database-resources:icu_payload", allow_single_file = True),
    "standard_frozen": attr.label(default = "//src/database-resources:wasix_standard_frozen", allow_single_file = True),
    "standard_construction": attr.label(default = "//src/database-resources:wasix_standard_construction", allow_single_file = True),
    "icu_construction": attr.label(default = "//src/database-resources:wasix_icu_construction", allow_single_file = True),
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
    _wasix_resource_test(name = name, runtime = "//src/database-resources:wasix_consumer_supplier", args = bun_test_entrypoint_args(name), size = "large", timeout = "long",
                         target_compatible_with = _LINUX_X64,
                         exec_compatible_with = _LINUX_X64 + ["@zig_sdk//libc:gnu.2.34"])

def wasix_sdk_resource_test(name):
    """Qualify SDK seed consumption independently of public resource admission."""
    labels = [
        "//src/wasix/sdks/rust:quality_resources_test",
        "//src/wasix/runtime:portable_payload",
        "//src/database-resources:icu_payload",
    ]
    seeds = ["//src/database-resources:wasix_" + profile + "_" + group for profile in ["standard", "icu"] for group in ["frozen", "construction"]]
    bun_script_test(name = name, entry_point = "//build_defs/resources:wasix_sdk_resource.test.mts",
        args = ["$(location " + label + ")" for label in labels] + [_VERSION, PRODUCTS["liboliphaunt-wasix"]["version"]] + ["$(location " + label + ")" for label in seeds],
        data = labels + seeds + ["//build_defs/resources:helpers"],
        source_files = ["//build_defs/resources:helpers"],
        size = "large", timeout = "long", target_compatible_with = _LINUX_X64,
        exec_compatible_with = _LINUX_X64 + ["@zig_sdk//libc:gnu.2.34"])

def native_resource_slice(name, templates, qualification):
    icu_row = [row for row in DATABASE_RESOURCE_ARTIFACTS if row["kind"] == "icu-data"][0]
    icu_payload(name = "icu_payload", out = icu_row["asset"].replace("{version}", _VERSION))
    icu_rows = _rows(["@oliphaunt/icu", "oliphaunt-icu", "dev.oliphaunt.runtime:oliphaunt-icu"])
    resource_carriers(name = "icu_carriers", kind = "icu", assets = [":icu_payload"], templates = templates, carriers = json.encode(icu_rows))
    packages = _shipping("icu_carriers", icu_rows)
    shipping_package(name = "icu_github", owner = "@oliphaunt_metadata//:product_database-resources", artifacts = [":icu_payload"], ecosystem = "github",
                     package_name = icu_row["asset"].replace("{version}", _VERSION), configuration = "portable", role = "github-release-asset")
    packages.append(":icu_github")
    platform_packages = {}
    for architecture, (target, compatible, condition) in _DESKTOP_PROFILES.items():
        selected = []
        for profile in DATABASE_RESOURCE_CONTRACT["profiles"]:
            prefix = architecture + "_" + profile
            icu = ":icu_payload" if profile == "icu" else None
            native_seed(name = prefix + "_seed", target = target, profile = profile, icu = icu,
                        target_compatible_with = compatible, exec_compatible_with = compatible,
                        **SEED_REUSE_CONTROLS.get("native/" + target + "/" + profile, {}))
            native.filegroup(name = prefix + "_frozen", srcs = [":" + prefix + "_seed"], output_group = "frozen")
            native.filegroup(name = prefix + "_abi", srcs = [":" + prefix + "_seed"], output_group = "abi")
            native.filegroup(name = prefix + "_construction", srcs = [":" + prefix + "_seed"], output_group = "construction")
            native.filegroup(name = prefix + "_specification", srcs = [":" + prefix + "_seed"], output_group = "specification")
            selected.extend(native_seed_envelopes(prefix, target, profile, ":" + prefix + "_seed", icu = icu, compatible = compatible))
        platform_packages[condition] = selected
    shipping_export(name = "icu_shipping_export", packages = packages, qualification = qualification + ["//src/database-resources/icu:icu_cargo_unit_test"], testonly = True)
    shipping_export(name = "native_target_shipping_export", packages = select(platform_packages), qualification = qualification, testonly = True, target_compatible_with = NATIVE_COMPATIBLE)
    shipping_export(name = name, packages = packages + select(platform_packages), qualification = qualification, testonly = True, target_compatible_with = NATIVE_COMPATIBLE)

def linux_resource_slice(name, templates, qualification):
    """Retain the original Linux entry point while sharing desktop construction."""
    native_resource_slice(name = "native_shipping_export", templates = templates, qualification = qualification)
    native.alias(name = name, actual = ":native_shipping_export", testonly = True, target_compatible_with = ["@platforms//os:linux"])

def _native_seed_consumer_test_impl(ctx):
    arguments = [ctx.file.runtime, ctx.file.consumer, PRODUCTS["liboliphaunt-native"]["version"], _VERSION, ctx.file.specification] + ctx.files.icu_files + ctx.files.seed_files
    files = [ctx.file.runtime, ctx.file.consumer, ctx.file.specification] + ctx.files.icu_files + ctx.files.seed_files
    return bun_test_entrypoint(ctx, ctx.file._script, arguments, files + ctx.files._helpers,
                              source_files = [ctx.file._script] + ctx.files._helpers,
                              additional_runfiles = ctx.attr.consumer[DefaultInfo].default_runfiles)

native_seed_consumer_test = rule(implementation = _native_seed_consumer_test_impl, cfg = desktop_profile, test = True, toolchains = BUN_SOURCE_TOOLCHAINS,
                               attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
    "runtime": attr.label(default = "//src/native/runtime:runtime_payload", allow_single_file = True),
    "consumer": attr.label(default = "//build_defs/resources:seed_consumer", allow_single_file = True),
    "specification": attr.label(mandatory = True, allow_single_file = True),
    "icu_files": attr.label_list(allow_files = True),
    "seed_files": attr.label_list(allow_files = True),
    "_script": attr.label(default = "//build_defs/resources:resource_slice.test.mts", allow_single_file = True),
    "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    "_helpers": attr.label_list(default = [
        "//build_defs/resources:helpers", "//build_defs/resources:shared.mts",
        "//src/native/sdks/ts:src/root-descriptor.ts", "//src/native/sdks/ts:src/native/filesystem-durability.ts",
        "//src/native/sdks/ts:src/native/cluster-seed.ts",
        "//src/database-resources:contracts/profile-probe.json",
    ], allow_files = True),
}))

def native_resource_test(name, compatible = NATIVE_COMPATIBLE):
    """Qualify the selected host using actual frozen seeds and final carriers."""
    seed_files = {}
    targets = {}
    for architecture, (target, _compatible, condition) in _DESKTOP_PROFILES.items():
        seed_files[condition] = [":" + architecture + "_" + profile + "_" + group
                                 for profile in sorted(DATABASE_RESOURCE_CONTRACT["profiles"])
                                 for group in ["archive", "manifest", "frozen", "abi", "carriers_npm_files", "carriers_cargo_files", "construction"]]
        targets[condition] = ":" + architecture + "_standard_specification"
    icu = [":icu_payload", ":icu_carriers_npm_files", ":icu_carriers_cargo_files", ":icu_carriers_maven_files"]
    native_seed_consumer_test(
        name = name,
        args = bun_test_entrypoint_args(name),
        specification = select(targets),
        icu_files = icu,
        seed_files = select(seed_files),
        target_compatible_with = compatible,
        size = "medium",
    )

def linux_resource_test(name):
    native_resource_test(name, compatible = ["@platforms//os:linux"])
