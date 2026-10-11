"""Release-feature Node-API construction from its actual locked Cargo inputs."""

load("@oliphaunt_metadata//:metadata.bzl", "EXTENSIONS", "PRODUCTS", "PUBLICATION_CARRIERS", "WASIX_ARTIFACTS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_file_action", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/languages:rust.bzl", "cargo_features")
load("//build_defs/release:identity.bzl", "ReleaseIdentityInfo")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")
load(":cargo.bzl", "RUNTIME_CARGO_HELPERS")
load(":npm.bzl", "RUNTIME_NPM_NOTICES")

WasixNapiInputsInfo = provider(fields = ["tree", "target", "triple", "sql_names", "sdk_version", "source_patch"])
WasixNapiReleaseInfo = provider(fields = ["binary", "inputs"])
WasixNapiCarrierInfo = provider(fields = ["npm", "github", "provenance", "target"])

NAPI_NOTICES = RUNTIME_NPM_NOTICES | {
    "//src/third-party/openssl:LICENSE.txt": "src/third-party/openssl/LICENSE.txt",
    "//src/third-party/openssl:source.toml": "src/third-party/openssl/source.toml",
}
NAPI_HELPERS = {label: True for label in RUNTIME_CARGO_HELPERS + [
    "//src/wasix/node-addon:tools/package-platform.mts",
    "//src/wasix/node-addon:tools/workspace-runtime-contract.mts",
    "//src/wasix/node-addon:tools/carrier-contract.mts",
    "//:tools/packaging/npm-package.mts",
    "//:tools/packaging/npm-trusted-publishing.mts",
    "//:tools/packaging/platform-binary-contract.mts",
    "//:tools/packaging/windows-vc-runtime-closure.mts",
    "//:tools/packaging/windows-vc-runtime-policy.json",
    "//tools/release:native-file-identity.mts",
]}.keys()

def _targets():
    return {row["target"]: row for row in WASIX_ARTIFACTS if row["product"] == "oliphaunt-wasix-napi" and row["kind"] == "wasix-napi-addon"}

def _selected(values):
    return select({"@rules_rust//rust/platform:" + row["triple"]: values[target] for target, row in _targets().items()})

def release_sql_names(facts):
    enabled = cargo_features(facts, ["release"])
    names = []
    for feature in enabled:
        if feature.startswith("extension-"):
            matches = [row["sql-name"] for row in EXTENSIONS.values() if feature == "extension-" + row["sql-name"].replace("_", "-")]
            if len(matches) != 1:
                fail("release Cargo extension feature has no unique canonical SQL member: " + feature)
            names.append(matches[0])
    if not names or len(names) != len({name: True for name in names}):
        fail("release Cargo extension closure must be nonempty and unique")
    return sorted(names)

def _inputs_impl(ctx):
    dependencies = []
    inputs = [ctx.file.cargo_lock, ctx.file.toolchain, ctx.file.source_patch]
    for target, name in ctx.attr.dependencies.items():
        files = {}
        for file in target[DefaultInfo].files.to_list():
            # These are source Files from the same registry repositories used
            # by crate_universe's compiled SDK, never ambient Cargo caches.
            if file.is_directory or not file.short_path.startswith("../"):
                fail("WASIX addon registry payload requires external source Files")
            member = "/".join(file.short_path.split("/")[2:])
            if member in files:
                fail("duplicate WASIX addon registry member " + member)
            files[member] = file.path
            inputs.append(file)
        dependencies.append({"name": name, "files": files})
    output = ctx.actions.declare_directory(ctx.label.name)
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({"target": ctx.attr.target_id, "targetTriple": ctx.attr.triple, "cargoLock": ctx.file.cargo_lock.path, "sourcePatch": ctx.file.source_patch.path, "sqlNames": ctx.attr.sql_names, "dependencies": dependencies, "output": output.path}))
    bun_file_action(ctx, ctx.file._stager, arguments = [spec.path], inputs = inputs + [spec],
                    source_files = ctx.files._helpers + [ctx.file.toolchain], outputs = [output], mnemonic = "WasixNapiLockedInputs")
    return [DefaultInfo(files = depset([output])), WasixNapiInputsInfo(tree = output, target = ctx.attr.target_id, triple = ctx.attr.triple, sql_names = ctx.attr.sql_names, sdk_version = ctx.attr.sdk_version, source_patch = ctx.file.source_patch)]

_inputs = rule(implementation = _inputs_impl, toolchains = BUN_SOURCE_TOOLCHAINS, attrs = {
    "dependencies": attr.label_keyed_string_dict(mandatory = True),
    "target_id": attr.string(mandatory = True), "triple": attr.string(mandatory = True), "sql_names": attr.string_list(mandatory = True),
    "sdk_version": attr.string(mandatory = True),
    "cargo_lock": attr.label(allow_single_file = True, mandatory = True),
    "source_patch": attr.label(default = "//build_defs/wasix:held-wasix-relocatable-includes.patch", allow_single_file = True),
    "toolchain": attr.label(default = "//src/wasix/runtime:toolchain.toml", allow_single_file = True),
    "_stager": attr.label(default = "//build_defs/wasix:napi-inputs.mts", allow_single_file = True),
    "_helpers": attr.label_list(default = NAPI_HELPERS, allow_files = True),
})

def wasix_napi_inputs(name, cargo_facts, registry_inputs):
    targets = _targets()
    _inputs(name = name, dependencies = _selected(registry_inputs), target_id = _selected({target: target for target in targets}),
            triple = _selected({target: row["triple"] for target, row in targets.items()}),
            sql_names = release_sql_names(cargo_facts[native.package_name()]), cargo_lock = "Cargo.lock",
            sdk_version = cargo_facts[native.package_name()]["dependencies"]["oliphaunt-wasix"]["version"].removeprefix("="))

def _release_profile_impl(settings, attr):
    return {"//command_line_option:compilation_mode": "opt", "@rules_rust//rust/settings:lto": "thin",
            "@rules_rust//rust/settings:codegen_units": 1, "@rules_rust//rust/settings:extra_rustc_flags": ["-Cstrip=symbols"]}

_release_profile = transition(implementation = _release_profile_impl, inputs = [], outputs = [
    "//command_line_option:compilation_mode", "@rules_rust//rust/settings:lto",
    "@rules_rust//rust/settings:codegen_units", "@rules_rust//rust/settings:extra_rustc_flags",
])

def _producer_impl(ctx):
    library = ctx.attr.library[0]
    files = library[DefaultInfo].files.to_list()
    if len(files) != 1 or files[0].is_directory:
        fail("WASIX addon release must supply exactly its maintained native cdylib")
    inputs = ctx.attr.inputs[0][WasixNapiInputsInfo]
    return [DefaultInfo(files = depset(files)), WasixNapiReleaseInfo(binary = files[0], inputs = inputs)]

wasix_napi_release = rule(implementation = _producer_impl, attrs = {
    "library": attr.label(mandatory = True, cfg = _release_profile),
    "inputs": attr.label(mandatory = True, providers = [WasixNapiInputsInfo], cfg = _release_profile),
    "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
})

def _carrier_impl(ctx):
    producer = ctx.attr.producer[WasixNapiReleaseInfo]
    owner = ctx.attr.owner[ReleaseIdentityInfo]
    row = _targets()[producer.inputs.target]
    if owner.id != "oliphaunt-wasix-napi":
        fail("WASIX addon carrier requires its canonical independent release owner")
    npm = ctx.actions.declare_file(ctx.label.name + ".tgz")
    github = ctx.actions.declare_file(row["asset"].replace("{version}", owner.version))
    provenance = ctx.actions.declare_file(ctx.label.name + ".provenance.json")
    inputs = [producer.binary, producer.inputs.tree, producer.inputs.source_patch, ctx.file.manifest, ctx.file.product_manifest, ctx.file.readme]
    notices = {}
    for target, destination in ctx.attr.notices.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory:
            fail("WASIX addon notice must be one declared File")
        notices[destination] = files[0].path
        inputs += files
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({"target": producer.inputs.target, "version": owner.version, "targetContract": row,
        "sdkVersion": producer.inputs.sdk_version, "sqlNames": producer.inputs.sql_names, "sourcePatch": producer.inputs.source_patch.path,
        "binary": producer.binary.path, "inputs": producer.inputs.tree.path, "manifest": ctx.file.manifest.path, "productManifest": ctx.file.product_manifest.path,
        "readme": ctx.file.readme.path, "notices": notices, "windowsRuntime": {file.basename: file.path for file in ctx.files.windows_runtime},
        "outputs": {"npm": npm.path, "github": github.path, "provenance": provenance.path}}))
    inputs += ctx.files.windows_runtime
    bun_file_action(ctx, ctx.file._packager, arguments = [spec.path], inputs = inputs + [spec], source_files = ctx.files._helpers,
                    outputs = [npm, github, provenance], mnemonic = "WasixNapiReleaseEnvelopes")
    return [DefaultInfo(files = depset([npm, github, provenance])), WasixNapiCarrierInfo(npm = npm, github = github, provenance = provenance, target = producer.inputs.target),
            OutputGroupInfo(npm = depset([npm]), github = depset([github]), provenance = depset([provenance]))]

_carrier = rule(implementation = _carrier_impl, toolchains = BUN_SOURCE_TOOLCHAINS, attrs = {
    "producer": attr.label(mandatory = True, providers = [WasixNapiReleaseInfo]),
    "owner": attr.label(mandatory = True, providers = [ReleaseIdentityInfo]),
    "manifest": attr.label(allow_single_file = True, mandatory = True), "readme": attr.label(allow_single_file = True, mandatory = True),
    "product_manifest": attr.label(default = "//src/wasix/node-addon:package.json", allow_single_file = True),
    "windows_runtime": attr.label_list(allow_files = True),
    "notices": attr.label_keyed_string_dict(default = NAPI_NOTICES, allow_files = True),
    "_packager": attr.label(default = "//build_defs/wasix:napi.mts", allow_single_file = True),
    "_helpers": attr.label_list(default = NAPI_HELPERS, allow_files = True),
})

def wasix_napi_carriers(producer, qualification = []):
    targets = _targets()
    directories = {target: row["npm_os"] + "-" + row["npm_cpu"] + ("-gnu" if row["npm_libc"] else "-msvc" if row["npm_os"] == "win32" else "") for target, row in targets.items()}
    _carrier(name = "release_carriers", producer = producer, owner = "@oliphaunt_metadata//:product_oliphaunt-wasix-napi",
             manifest = _selected({target: "packages/" + directory + "/package.json" for target, directory in directories.items()}),
             readme = _selected({target: "packages/" + directory + "/README.md" for target, directory in directories.items()}),
             windows_runtime = select({"//build_defs/native:windows_x64": ["@native_msvc_sdk//:runtime_dlls"], "//conditions:default": []}))
    packages = []
    for ecosystem in ["npm", "github", "provenance"]:
        name = ecosystem + "_release_shipping"
        native.filegroup(name = name + "_files", srcs = [":release_carriers"], output_group = ecosystem)
        package_name = _selected({target: row["npm_package"] if ecosystem == "npm" else row["asset"].replace("{version}", PRODUCTS["oliphaunt-wasix-napi"]["version"]) if ecosystem == "github" else "wasix-napi-provenance" for target, row in targets.items()})
        npm_rows = {}
        if ecosystem == "npm":
            for target, row in targets.items():
                carriers = [carrier for carrier in PUBLICATION_CARRIERS if carrier["product"] == "oliphaunt-wasix-napi" and carrier["ecosystem"] == "npm" and carrier["name"] == row["npm_package"]]
                if len(carriers) != 1:
                    fail("WASIX addon must own exactly its canonical npm platform leaf")
                npm_rows[target] = carriers[0]
        shipping_package(name = name, owner = "@oliphaunt_metadata//:product_oliphaunt-wasix-napi", artifacts = [":" + name + "_files"], ecosystem = ecosystem if ecosystem != "provenance" else "internal", package_name = package_name,
                         configuration = _selected({target: npm_rows[target]["target"] if ecosystem == "npm" else target for target in targets}),
                         role = _selected({target: npm_rows[target]["role"] for target in targets}) if ecosystem == "npm" else "github-release-asset" if ecosystem == "github" else "construction-provenance")
        packages.append(":" + name)
    shipping_export(name = "release_shipping_export", packages = packages, qualification = qualification, testonly = True)

def _installed_impl(ctx):
    producer = ctx.attr.producer[WasixNapiReleaseInfo]
    carrier = ctx.attr.carrier[WasixNapiCarrierInfo]
    if carrier.target != producer.inputs.target:
        fail("installed addon must use the exact native release producer configuration")
    lifecycles = []
    for name in producer.inputs.sql_names:
        rows = [row for row in EXTENSIONS.values() if row["sql-name"] == name]
        if len(rows) != 1:
            fail("installed addon SQL lifecycle must be canonical and unique: " + name)
        row = rows[0]
        lifecycle = row["lifecycle"]
        if lifecycle["preload-required"] or lifecycle["restart-required"] or lifecycle["shared-memory-required"]:
            fail("installed default addon member requires an unmodeled server lifecycle: " + name)
        lifecycles.append({"sqlName": name, "dependencies": row["dependencies"], "create": lifecycle["create-extension"],
                           "schema": lifecycle.get("create-schema"), "loadSql": lifecycle["load-sql"], "postCreateSql": lifecycle["post-create-sql"]})
    metadata = ctx.actions.declare_file(ctx.label.name + ".lifecycles.json")
    ctx.actions.write(metadata, json.encode({"targetTriple": producer.inputs.triple, "sdkVersion": producer.inputs.sdk_version, "lifecycles": lifecycles}))
    node = ctx.toolchains["@rules_nodejs//nodejs:toolchain_type"].nodeinfo.node
    if not node:
        fail("installed WASIX addon requires its pinned Node toolchain")
    files = [carrier.npm, metadata, node, ctx.file._consumer, ctx.file.product_manifest, producer.inputs.source_patch] + ctx.files._helpers
    return bun_test_entrypoint(ctx, ctx.file._runner, [carrier.npm, metadata, node, ctx.file._consumer, ctx.file.product_manifest, producer.inputs.source_patch], files,
                               source_files = [ctx.file._runner, ctx.file._consumer] + ctx.files._helpers)

_installed_test = rule(implementation = _installed_impl, test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS + ["@rules_nodejs//nodejs:toolchain_type"],
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "producer": attr.label(mandatory = True, providers = [WasixNapiReleaseInfo]),
        "carrier": attr.label(mandatory = True, providers = [WasixNapiCarrierInfo]),
        "product_manifest": attr.label(default = "//src/wasix/node-addon:package.json", allow_single_file = True),
        "_runner": attr.label(default = "//build_defs/wasix:napi-installed.test.mts", allow_single_file = True),
        "_consumer": attr.label(default = "//build_defs/wasix:napi-consumer.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = NAPI_HELPERS + ["//src/wasix/sdks/ts:tools/pgwire-client.mts"], allow_files = True),
    }))

def wasix_napi_installed_test(name, **kwargs):
    _installed_test(name = name, args = bun_test_entrypoint_args(name), **kwargs)
