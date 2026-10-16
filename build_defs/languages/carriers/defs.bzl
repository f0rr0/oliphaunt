"""Public native helper envelopes from constructed binaries and canonical rows."""

load("@oliphaunt_metadata//:metadata.bzl", "COMPLETED_SUPPLIER_PUBLICATIONS", "NATIVE_HELPER_ARTIFACTS", "PRODUCTS", "PUBLICATION_CARRIERS")
load("@native_cargo_metadata//:cargo.bzl", "CARGO")
load("@aspect_rules_js//npm:providers.bzl", "NpmPackageInfo")
load("@cargo_crates//:defs.bzl", "crate_deps")
load("@rules_cc//cc:find_cc_toolchain.bzl", "use_cc_toolchain")
load("@bazel_skylib//lib:paths.bzl", "paths")
load("//build_defs/extensions:platforms.bzl", "NATIVE_EXTENSION_CONFIGURATION")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_file_action", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/languages:cargo-toolchain.bzl", "cargo_test_toolchain")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")
load("//build_defs/release:supplier.bzl", "rust_shipping_supplier", "shipping_suppliers")

_CONFIGURATIONS = {
    "linux-x64-gnu": "//build_defs/native:linux_x86_64",
    "linux-arm64-gnu": "//build_defs/native:linux_aarch64_gnu_2_28",
    "macos-arm64": "//build_defs/native:macos_arm64",
    "windows-x64-msvc": "//build_defs/native:windows_x64",
}
_HELPERS = [
    "//src/native/node-addon:tools/dependency-license-contract.mts",
    "//src/native/broker:tools/broker-dependency-license-contract.mts",
    "//:tools/packaging/archive-directory.mts",
    "//:tools/packaging/cargo-source-package.mts",
    "//:tools/packaging/cargo-manifest.mts",
    "//:tools/packaging/npm-trusted-publishing.mts",
    "//:tools/packaging/package-archive.mts",
    "//:tools/packaging/platform-binary-contract.mts",
    "//:tools/packaging/portable-archive.mts",
    "//:tools/packaging/release-notices.mts",
    "//:tools/packaging/release-directory-safety.mts",
    "//:tools/packaging/rust-dependency-license-contract.mts",
    "//:tools/packaging/windows-vc-runtime-closure.mts",
    "//:tools/packaging/windows-vc-runtime-policy.json",
    "//tools/release:platform-compatibility-policy.mts",
]

def _input_paths(entries, inputs):
    result = {}
    for target, destination in entries.items():
        for file in target[DefaultInfo].files.to_list():
            name = destination
            if destination.endswith("/"):
                prefix = target.label.package + "/"
                if not file.short_path.startswith(prefix):
                    fail("native helper source is outside its declared package: " + file.short_path)
                name += file.short_path[len(prefix):]
            if name in result:
                fail("duplicate native helper input " + name)
            result[name] = file.path
            inputs.append(file)
    return result

def _package_impl(ctx):
    inputs = [ctx.file.binary, ctx.file._packager] + ctx.files._helpers
    github = ctx.actions.declare_file(ctx.attr.github_out)
    npm = ctx.actions.declare_file(ctx.attr.npm_out)
    outputs = [github, npm]
    specification = json.decode(ctx.attr.metadata)
    specification.update({
        "binary": ctx.file.binary.path,
        "sources": _input_paths(ctx.attr.sources, inputs),
        "legal": _input_paths(ctx.attr.legal, inputs),
        "windowsRuntime": {file.basename: file.path for file in ctx.files.windows_runtime},
        "outputs": {"github": github.path, "npm": npm.path},
    })
    inputs += ctx.files.windows_runtime
    groups = {"github": depset([github]), "npm": depset([npm])}
    if ctx.attr.cargo_out:
        cargo = ctx.actions.declare_file(ctx.attr.cargo_out)
        specification["outputs"]["cargo"] = cargo.path
        outputs.append(cargo)
        groups["cargo"] = depset([cargo])
    manifest = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(manifest, json.encode(specification))
    arguments = ctx.actions.args()
    arguments.add(manifest)
    bun_file_action(ctx, entry_point = ctx.file._packager, source_files = [ctx.file._packager] + ctx.files._helpers, arguments = [arguments], inputs = depset(inputs + [manifest]), outputs = outputs, mnemonic = "NativeHelperEnvelope")
    return [DefaultInfo(files = depset(outputs)), OutputGroupInfo(**groups)]

_native_helper_package = rule(
    implementation = _package_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "binary": attr.label(allow_single_file = True, mandatory = True),
        "metadata": attr.string(mandatory = True),
        "sources": attr.label_keyed_string_dict(allow_files = True),
        "legal": attr.label_keyed_string_dict(allow_files = True),
        "windows_runtime": attr.label_list(allow_files = True),
        "github_out": attr.string(mandatory = True),
        "npm_out": attr.string(mandatory = True),
        "cargo_out": attr.string(),
        "_packager": attr.label(default = Label("//build_defs/languages/carriers:package.mts"), allow_single_file = True),
        "_helpers": attr.label_list(default = [Label(label) for label in _HELPERS], allow_files = True),
    },
)

def _compiled_suppliers(name, path_dependencies):
    inputs = []
    for dependency, declaration in CARGO[native.package_name()]["dependencies"].items():
        rows = [row for row in PUBLICATION_CARRIERS if row["ecosystem"] == "cargo" and row["name"] == dependency]
        if not rows:
            continue
        if len(rows) != 1:
            fail("native helper supplier must identify one conventional Cargo owner: " + dependency)
        row = rows[0]
        supplier = name + "_" + dependency.replace("-", "_")
        if type(declaration) == "dict" and "path" in declaration:
            source = paths.normalize(paths.join(native.package_name(), declaration["path"]))
            owner = PRODUCTS[row["product"]]
            if source != owner["path"] or source not in CARGO or CARGO[source]["name"] != dependency or CARGO[source]["version"] != owner["version"]:
                fail("native helper path supplier differs from its conventional release owner: " + dependency)
            if dependency not in path_dependencies:
                fail("native helper path supplier needs the same declared compiler dependency: " + dependency)
            rust_shipping_supplier(name = supplier, producer = path_dependencies[dependency], owner = "@oliphaunt_metadata//:product_" + row["product"],
                                   current_source = True, source_package = source, configuration = NATIVE_EXTENSION_CONFIGURATION)
            inputs.append(":" + supplier)
            continue
        version = declaration if type(declaration) == "string" else declaration["version"]
        key = row["product"] + "@" + version.removeprefix("=")
        producers = crate_deps([dependency], package_name = native.package_name())
        if len(producers) != 1:
            fail("native helper supplier must identify one actual registry crate target")
        rust_shipping_supplier(name = supplier, producer = producers[0], owner = "@oliphaunt_metadata//:product_" + row["product"],
                               origin = json.encode({"kind": "completed-publication", "publication": COMPLETED_SUPPLIER_PUBLICATIONS[key], "artifact": "cargo:" + dependency}) if key in COMPLETED_SUPPLIER_PUBLICATIONS else "")
        inputs.append(":" + supplier)
    shipping_suppliers(name = name, inputs = inputs)

def native_helper_carriers(product, binary, qualification, path_dependencies = {}):
    _compiled_suppliers("native_compiled_suppliers", path_dependencies)
    suppliers = ":native_compiled_suppliers"
    descriptor = PRODUCTS[product]
    rows = [row for row in NATIVE_HELPER_ARTIFACTS if row["product"] == product and row["kind"] in ["broker-helper", "node-direct-addon"]]
    carriers = [row for row in PUBLICATION_CARRIERS if row["product"] == product]
    metadata = {}
    sources = {}
    github_names = {}
    physical_targets = {}
    npm_names = {}
    npm_identities = {}
    npm_targets = {}
    npm_roles = {}
    cargo_names = {}
    cargo_identities = {}
    cargo_roles = {}
    compatible = {}
    for artifact in rows:
        target = artifact["target"]
        if target not in _CONFIGURATIONS:
            fail("no native helper configuration for declared target " + target)
        configuration = _CONFIGURATIONS[target]
        metadata[configuration] = json.encode({"product": product, "version": descriptor["version"], "artifact": artifact, "carriers": carriers})
        npm = [row for row in carriers if row["ecosystem"] == "npm" and row["name"] == artifact["npm_package"]]
        if len(npm) != 1:
            fail("canonical npm helper identity is not unique for " + target)
        npm = npm[0]
        directory = "packages/" + npm["target"]
        sources[configuration] = {directory + "/package.json": "package.json", directory + "/README.md": "README.md"}
        github_names[configuration] = artifact["asset"].replace("{version}", descriptor["version"])
        physical_targets[configuration] = target
        npm_names[configuration] = npm["name"].replace("@", "").replace("/", "-") + "-" + npm["version"] + ".tgz"
        npm_identities[configuration] = npm["name"]
        npm_targets[configuration] = npm["target"]
        npm_roles[configuration] = npm["role"]
        compatible[configuration] = []
        if product == "oliphaunt-broker":
            cargo = [row for row in carriers if row["ecosystem"] == "cargo" and row["target"] == target and row["role"] != "facade"]
            if len(cargo) != 1:
                fail("canonical Cargo helper identity is not unique for " + target)
            cargo = cargo[0]
            sources[configuration].update({file: "cargo/" + file[len("crates/" + target + "/"):] for file in native.glob(["crates/" + target + "/**"], exclude = ["**/target/**"])})
            cargo_names[configuration] = cargo["name"] + "-" + cargo["version"] + ".crate"
            cargo_identities[configuration] = cargo["name"]
            cargo_roles[configuration] = cargo["role"]
    legal = {"//:" + name: name for name in ["LICENSE", "THIRD_PARTY_NOTICES.md", "Cargo.lock"]}
    legal["dependency-licenses.json"] = descriptor["path"] + "/dependency-licenses.json"
    legal.update({file: descriptor["path"] + "/" + file for file in native.glob(["dependency-license-blobs/*.base64"])})
    _native_helper_package(
        name = "native_carriers", binary = binary, metadata = select(metadata), sources = select(sources), legal = legal,
        windows_runtime = select({"//build_defs/native:windows_x64": ["@native_msvc_sdk//:runtime_dlls"], "//conditions:default": []}),
        github_out = select(github_names), npm_out = select(npm_names), cargo_out = select(cargo_names) if cargo_names else "",
        target_compatible_with = select(compatible | {"//conditions:default": ["@platforms//:incompatible"]}),
    )
    native.filegroup(name = "github_archive", srcs = [":native_carriers"], output_group = "github")
    native.filegroup(name = "npm", srcs = [":native_carriers"], output_group = "npm")
    shipping_package(name = "native_github_shipping", owner = "@oliphaunt_metadata//:product_" + product, artifacts = [":github_archive"], ecosystem = "github", package_name = select(github_names), configuration = select(physical_targets), role = "github-release-asset", suppliers = suppliers)
    shipping_package(name = "native_npm_shipping", owner = "@oliphaunt_metadata//:product_" + product, artifacts = [":npm"], ecosystem = "npm", package_name = select(npm_identities), configuration = select(npm_targets), role = select(npm_roles), suppliers = suppliers)
    shipping = [":native_github_shipping", ":native_npm_shipping"]
    if cargo_names:
        native.filegroup(name = "artifact_crate", srcs = [":native_carriers"], output_group = "cargo")
        shipping_package(name = "native_cargo_shipping", owner = "@oliphaunt_metadata//:product_" + product, artifacts = [":artifact_crate"], ecosystem = "cargo", package_name = select(cargo_identities), configuration = select(physical_targets), role = select(cargo_roles), suppliers = suppliers)
        shipping.append(":native_cargo_shipping")
    shipping_export(name = "native_shipping_export", packages = shipping, qualification = qualification, testonly = True)

def _unit_inputs_impl(ctx):
    inputs = []
    sources = _input_paths(ctx.attr.sources, inputs)
    legal = _input_paths(ctx.attr.legal, inputs)
    inputs += ctx.files.windows_runtime
    cases = []
    for metadata in json.decode(ctx.attr.metadata):
        owner = PRODUCTS[metadata["product"]]["path"]
        npm = [row for row in metadata["carriers"] if row["ecosystem"] == "npm" and row["name"] == metadata["artifact"]["npm_package"]][0]
        directory = owner + "/packages/" + npm["target"]
        entries = {"package.json": sources[directory + "/package.json"], "README.md": sources[directory + "/README.md"]}
        if metadata["product"] == "oliphaunt-broker":
            prefix = owner + "/crates/" + metadata["artifact"]["target"] + "/"
            entries.update({"cargo/" + name[len(prefix):]: file for name, file in sources.items() if name.startswith(prefix)})
        metadata.update({
            "sources": entries,
            "legal": {name: file for name, file in legal.items() if name in ["LICENSE", "THIRD_PARTY_NOTICES.md", "Cargo.lock"] or name.startswith(owner + "/")},
            "windowsRuntime": {file.basename: file.short_path for file in ctx.files.windows_runtime} if metadata["artifact"]["target"] == "windows-x64-msvc" else {},
        })
        cases.append(metadata)
    output = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.write(output, json.encode(cases))
    return [DefaultInfo(files = depset([output]), runfiles = ctx.runfiles(files = inputs + [output]))]

_native_helper_unit_inputs = rule(
    implementation = _unit_inputs_impl,
    attrs = {"metadata": attr.string(mandatory = True), "sources": attr.label_keyed_string_dict(allow_files = True), "legal": attr.label_keyed_string_dict(allow_files = True), "windows_runtime": attr.label_list(allow_files = True)},
)

def native_helper_unit_inputs(name):
    sources = {}
    legal = {"//:" + file: file for file in ["LICENSE", "THIRD_PARTY_NOTICES.md", "Cargo.lock"]}
    for product in ["oliphaunt-node-direct", "oliphaunt-broker"]:
        owner = PRODUCTS[product]["path"]
        sources["//" + owner + ":carrier_template_sources"] = owner + "/"
        legal["//" + owner + ":carrier_legal_sources"] = owner + "/"
    _native_helper_unit_inputs(name = name, sources = sources, legal = legal, windows_runtime = select({"//build_defs/native:windows_x64": ["@native_msvc_sdk//:runtime_dlls"], "//conditions:default": []}), metadata = json.encode([
        {"product": row["product"], "version": PRODUCTS[row["product"]]["version"], "artifact": row, "carriers": [carrier for carrier in PUBLICATION_CARRIERS if carrier["product"] == row["product"]]}
        for row in NATIVE_HELPER_ARTIFACTS if row["kind"] in ["broker-helper", "node-direct-addon"]
    ]))

def native_helper_test_data():
    return _HELPERS + ["package.mts"]

def _runfile(ctx, file):
    return file.short_path[3:] if file.short_path.startswith("../") else ctx.workspace_name + "/" + file.short_path

def _installed_sql_impl(ctx):
    node = ctx.toolchains["@rules_nodejs//nodejs:toolchain_type"].nodeinfo.node
    if not node:
        fail("Installed native SDK consumers require the pinned Node executable")
    rust = ctx.toolchains["@rules_rust//rust:toolchain_type"]
    if not rust.cargo:
        fail("Installed broker Cargo leaf requires the pinned Cargo executable")
    if "deno" in ctx.attr.contract_hosts and not ctx.executable.deno:
        fail("Installed native SDK contracts require the declared pinned Deno executable")
    cc = cargo_test_toolchain(ctx)
    server_packages = {}
    server_files = [ctx.file._server_contract]
    for target, identity in ctx.attr.server_packages.items():
        package = target[NpmPackageInfo]
        row = json.decode(ctx.attr.server_metadata[identity])
        if package.package != row["package"] or package.version != row["version"] or package.src.is_directory:
            fail("Installed server driver differs from its declared npm archive identity")
        server_packages[identity] = dict(row, archive = _runfile(ctx, package.src))
        server_files.append(package.src)
    if sorted(server_packages.keys()) != sorted(ctx.attr.server_metadata.keys()):
        fail("Installed server driver archive closure differs from its metadata")
    server = ctx.actions.declare_file(ctx.label.name + ".server.json")
    ctx.actions.write(server, json.encode({
        "contract": _runfile(ctx, ctx.file._server_contract),
        "packages": server_packages,
        "roots": ctx.attr.server_roots,
        "restrictedLauncher": _runfile(ctx, ctx.executable.restricted_launcher) if ctx.executable.restricted_launcher else None,
    }))
    server_files += [ctx.executable.restricted_launcher] if ctx.executable.restricted_launcher else []
    arguments = [ctx.file.sdk, ctx.file.query, ctx.file.addon, ctx.file.broker, ctx.file.runtime, node, ctx.file._consumer, ctx.file.artifact_crate, rust.cargo, rust.rustc, rust.rust_doc, cc.configuration,
                 ctx.file._contract_entry, ctx.file._contract_assertions, ctx.executable.deno or "", json.encode(ctx.attr.contract_hosts), server]
    files = arguments[:14] + [server] + server_files + ([ctx.executable.deno] if ctx.executable.deno else []) + ctx.files._helpers + rust.all_files.to_list() + cc.files
    return bun_test_entrypoint(ctx, runner = ctx.file._runner, arguments = arguments, files = files, runfiles_argument = True, source_files = [ctx.file._runner] + ctx.files._helpers,
                               additional_runfiles = ctx.attr.deno[DefaultInfo].default_runfiles if ctx.attr.deno else None)

_native_installed_sql_test = rule(
    implementation = _installed_sql_impl,
    test = True,
    fragments = ["cpp"],
    toolchains = BUN_SOURCE_TOOLCHAINS + ["@rules_nodejs//nodejs:toolchain_type", "@rules_rust//rust:toolchain_type"] + use_cc_toolchain(),
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "sdk": attr.label(mandatory = True, allow_single_file = [".tgz"]),
        "query": attr.label(mandatory = True, allow_single_file = [".tgz"]),
        "addon": attr.label(mandatory = True, allow_single_file = [".tgz"]),
        "broker": attr.label(mandatory = True, allow_single_file = [".tgz"]),
        "runtime": attr.label(mandatory = True, allow_single_file = [".tgz"]),
        "artifact_crate": attr.label(mandatory = True, allow_single_file = [".crate"]),
        "deno": attr.label(executable = True, cfg = "exec", allow_files = True),
        "contract_hosts": attr.string_list(default = ["node"]),
        "server_packages": attr.label_keyed_string_dict(providers = [NpmPackageInfo], mandatory = True),
        "server_metadata": attr.string_dict(mandatory = True),
        "server_roots": attr.string_dict(mandatory = True),
        "restricted_launcher": attr.label(executable = True, cfg = "target", allow_files = True),
        "_server_contract": attr.label(default = Label("//src/native/sdks/ts:src/__tests__/native-server-smoke.ts"), allow_single_file = True),
        "_contract_entry": attr.label(default = Label("//src/native/sdks/ts:src/__tests__/native-smoke.mts"), allow_single_file = True),
        "_contract_assertions": attr.label(default = Label("//src/native/sdks/ts:src/__tests__/native-direct-contract.mts"), allow_single_file = True),
        "_runner": attr.label(default = Label("//build_defs/languages/carriers:installed-sql.test.mts"), allow_single_file = True),
        "_consumer": attr.label(default = Label("//build_defs/languages/carriers:sql-consumer.mts"), allow_single_file = True),
        "_helpers": attr.label_list(default = [Label("//:tools/packaging/portable-archive.mts"), Label("//:tools/packaging/windows-vc-runtime-closure.mts"), Label("//:tools/packaging/windows-vc-runtime-policy.json"), Label("//build_defs/native:host-runtime-test-helpers.mts"), Label("//build_defs/languages:cargo-environment.mts"), Label("//build_defs/languages/carriers:cargo-consumer.mts")], allow_files = True),
    }),
)

def native_installed_sql_test(name, args = [], **kwargs):
    _native_installed_sql_test(name = name, args = bun_test_entrypoint_args(name) + args, **kwargs)
