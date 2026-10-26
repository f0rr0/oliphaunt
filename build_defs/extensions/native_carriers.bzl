"""Selected desktop extension final envelopes from their typed member producers."""

load("@oliphaunt_metadata//:metadata.bzl", "EXTENSIONS", "EXTENSION_COMPATIBILITY", "EXTENSION_DEPENDENCIES", "EXTENSION_NATIVE_TARGETS", "EXTENSION_RECIPES", "EXTENSION_RELEASE_METADATA", "EXTENSION_SOURCES", "PRODUCTS", "PUBLICATION_CARRIERS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action", "bun_script_test")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")
load("//build_defs/release:supplier.bzl", "ShippingSupplierInfo")
load(":extensions.bzl", "ExtensionMemberInfo", "extension_identity")
load(":final_leaf.bzl", "ExtensionFinalLeafInfo")
load(":platforms.bzl", "NATIVE_EXTENSION_COMPATIBLE", "NATIVE_EXTENSION_LINUX_COMPATIBLE")
load(":smoke.bzl", "extension_smoke_plan", "native_extension_payload_closure")

_LINUX_TARGETS = {"//build_defs/native:linux_x86_64": "linux-x64-gnu", "//build_defs/native:linux_aarch64_gnu_2_28": "linux-arm64-gnu"}
_TARGETS = _LINUX_TARGETS | {"//build_defs/native:macos_arm64": "macos-arm64", "//build_defs/native:windows_x64": "windows-x64-msvc"}

def extension_owner_metadata():
    """Stable ownership projection shared by declared package writers."""
    return {row["sqlName"]: {
        "product": row["artifactProduct"],
        "versioning": row["versioning"],
        "native": row["compatibility"]["nativeRuntimeProduct"] if row["class"] == "contrib" else row["artifactProduct"],
        "wasix": row["compatibility"]["wasixRuntimeProduct"] if row["class"] == "contrib" else row["artifactProduct"],
    } for row in EXTENSION_RELEASE_METADATA}

def native_extension_carrier_helpers():
    return [
        "//build_defs/extensions:validate_member_payload.mts",
        "//:src/extensions/artifacts/native/tools/stage-windows-binary-contract.mts",
        "//src/database-resources:seeds/carrier-identities.mts",
        "//:src/extensions/artifacts/packages/tools/contrib-carriers.mts",
        "//:src/extensions/artifacts/packages/tools/extension-artifact-inventory.mts",
        "//:src/extensions/artifacts/packages/tools/extension-registry-packages.mts",
        "//:src/extensions/artifacts/packages/tools/extension-runtime-asset-contract.mts",
        "//:src/extensions/artifacts/packages/tools/package-extension-release-carriers.mts",
        "//src/extensions/contracts:extension-target-profiles.mts",
        "//src/extensions/contracts:wasix-extension-install.mts",
        "//src/extensions/contracts:extension-artifact-archive-policy.properties",
        "//src/extensions/tools:extension-artifact-archive-policy.mts",
        "//src/extensions/tools:extension-upstream-licenses.mts",
        "//build_defs/extensions/compiler_rt:source.json",
        "//src/native/mobile-bindings:tools/dependency-license-contract.mts",
        "//src/native/sdks/swift:tools/ios-carrier-manifest.mts",
        "//src/native/sdks/swift:tools/native-legal-source-basis.mts",
        "//src/native/sdks/swift:tools/swift-native-carrier-contract.mts",
        "//src/native/sdks/ts:src/native/extension-contract.ts",
        "//src/wasix/runtime:tools/check-release-assets.mts",
        "//src/wasix/runtime:tools/wasix-aot-manifest.mts",
        "//src/wasix/runtime:tools/wasix-cargo-artifact-contract.mts",
        "//src/wasix/runtime:tools/wasix-cargo-toolchain-policy.mts",
        "//src/wasix/runtime/engine:sources.json",
        "//src/wasix/runtime:tools/wasix-runtime-npm-contract.mts",
        "//:tools/packaging/archive-directory.mts",
        "//:tools/packaging/cargo-manifest.mts",
        "//:tools/packaging/cargo-source-package.mts",
        "//:tools/packaging/npm-package.mts",
        "//:tools/packaging/npm-trusted-publishing.mts",
        "//:tools/packaging/package-archive.mts",
        "//:tools/packaging/platform-binary-contract.mts",
        "//:tools/packaging/portable-archive.mts",
        "//:tools/packaging/release-directory-safety.mts",
        "//:tools/packaging/release-notices.mts",
        "//:tools/packaging/rust-build-script-sha256.mts",
        "//:tools/packaging/rust-dependency-license-contract.mts",
        "//:tools/packaging/windows-vc-runtime-closure.mts",
        "//:tools/packaging/windows-vc-runtime-policy.json",
        "//tools/release:compatibility-version-parser.mts",
        "//tools/release:extension-release-metadata.mts",
        "//tools/release:platform-compatibility-policy.mts",
        "//tools/release:release-artifact-targets.mts",
        "//tools/release:release-graph.mts",
        "//tools/release:release-history.mts",
    ]

def native_extension_carrier_legal(sql_name):
    inputs = ["//:LICENSE", "//:THIRD_PARTY_NOTICES.md"]
    package = "//src/extensions/external/" + sql_name + ":"
    inputs += [package + name for name in ["release.toml", "source.toml", "upstream-license-data.json"]]
    if sql_name in EXTENSION_RECIPES:
        inputs.append(package + "recipe.toml")
    if EXTENSION_NATIVE_TARGETS.get(sql_name):
        inputs.append(package + "targets/native.toml")
    # Each audited license source is checked against its immutable source manifest.
    inputs += [package + "dependencies/" + name + "/source.toml" for name in EXTENSION_DEPENDENCIES.get(sql_name, {})]
    return inputs

def native_external_carrier_metadata(sql_name, target, products = PRODUCTS):
    product = EXTENSION_SOURCES[sql_name]["product"]
    release = [row for row in EXTENSION_RELEASE_METADATA if row["sqlName"] == sql_name]
    if len(release) != 1:
        fail("external final carrier requires exactly one canonical release metadata row")
    return {"product": product, "version": products[product]["version"], "sqlName": sql_name, "target": target, "runtimeVersion": EXTENSION_COMPATIBILITY[sql_name]["native_runtime_version"],
            "descriptor": EXTENSIONS[sql_name], "recipe": EXTENSION_RECIPES.get(sql_name, {}), "source": EXTENSION_SOURCES[sql_name],
            "selectedDependencies": sorted([name for name in EXTENSIONS[sql_name].get("dependencies", []) if name in EXTENSIONS]),
            "compatibility": EXTENSION_COMPATIBILITY[sql_name], "releaseMetadata": release[0], "ownerMetadata": extension_owner_metadata(), "carriers": [row for row in PUBLICATION_CARRIERS if row["product"] == product]}

def _leaf(spec, ecosystem):
    facades = [row for row in spec["carriers"] if row["ecosystem"] == "npm" and row["target"] == None]
    if len(facades) != 1:
        fail("native extension envelope requires exactly its canonical npm facade")
    name = (facades[0]["name"] if ecosystem == "npm" else spec["product"]) + "-" + spec["target"]
    rows = [row for row in spec["carriers"] if row["ecosystem"] == ecosystem and row["target"] == spec["target"] and row["name"] == name]
    if len(rows) != 1:
        fail("native extension envelope must have exactly one canonical " + ecosystem + " identity")
    return rows[0]

def _carriers_impl(ctx):
    member = ctx.attr.member[ExtensionMemberInfo]
    spec = native_external_carrier_metadata(member.sql_name, member.configuration)
    if spec["product"] != member.owner:
        fail("final extension envelope owner differs from its canonical member producer")
    github = ctx.actions.declare_file(spec["product"] + "-" + spec["version"] + "-native-" + member.configuration + "-runtime.tar.gz")
    npm = ctx.actions.declare_file(_leaf(spec, "npm")["name"].replace("@", "").replace("/", "-") + "-" + spec["version"] + ".tgz")
    cargo = ctx.actions.declare_directory(ctx.label.name + "/cargo")
    manifest = ctx.actions.declare_file(ctx.label.name + "/" + spec["product"] + "-" + spec["version"] + "-manifest.json")
    frozen = ctx.actions.declare_file(ctx.label.name + "/extension-artifacts.json")
    spec.update({"archive": member.archive.path, "outputs": {"github": github.path, "npm": npm.path, "cargo": cargo.path, "manifest": manifest.path, "frozen": frozen.path}})
    inputs = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(inputs, json.encode(spec))
    bun_file_action(ctx, ctx.file._tool, arguments = [inputs.path], inputs = [member.archive, member.inventory, inputs] + ctx.files.legal,
                    source_files = [ctx.file._tool] + ctx.files._helpers + ctx.files.legal,
                    outputs = [github, npm, cargo, manifest, frozen], mnemonic = "NativeExtensionEnvelopes")
    return [DefaultInfo(files = depset([github, npm, cargo, manifest, frozen])), ctx.attr.member[ShippingSupplierInfo],
            ExtensionFinalLeafInfo(product = spec["product"], owner = member.owner, version = spec["version"], family = "native", target = member.configuration, metadata = spec, github = [github], npm = [npm], cargo = [cargo], manifest = manifest, frozen = frozen, spec = inputs, validation = None, receipt = None, origin = None),
            OutputGroupInfo(github = depset([github]), npm = depset([npm]), cargo = depset([cargo]), manifest = depset([manifest]), frozen = depset([frozen]), spec = depset([inputs]))]

_native_extension_carriers = rule(implementation = _carriers_impl, toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {"member": attr.label(mandatory = True, providers = [ExtensionMemberInfo, ShippingSupplierInfo]), "legal": attr.label_list(allow_files = True),
             "_tool": attr.label(default = "//build_defs/extensions:native_carriers.mts", allow_single_file = True),
             "_helpers": attr.label_list(default = native_extension_carrier_helpers(), allow_files = True)})

def native_external_extension_carriers(sql_name, member = ":native_payload", additional_qualification = []):
    # PostGIS's foreign dependency recipes are not inherited from generic desktop modules.
    targets = _TARGETS
    compatible = NATIVE_EXTENSION_COMPATIBLE
    _native_extension_carriers(name = "native_carriers", member = member, legal = native_extension_carrier_legal(sql_name), target_compatible_with = compatible)
    metadata = {condition: native_external_carrier_metadata(sql_name, target) for condition, target in targets.items()}
    packages = []
    for ecosystem in ["github", "npm", "cargo"]:
        name = "native_" + ecosystem + "_shipping"
        native.filegroup(name = name + "_files", srcs = [":native_carriers"], output_group = ecosystem)
        names, roles = {}, {}
        for condition, spec in metadata.items():
            if ecosystem == "github":
                names[condition] = spec["product"] + "-" + spec["version"] + "-native-" + spec["target"] + "-runtime.tar.gz"
                roles[condition] = "github-release-asset"
            else:
                row = _leaf(spec, ecosystem)
                names[condition], roles[condition] = row["name"], row["role"]
        shipping_package(name = name, owner = extension_identity(sql_name), artifacts = [":" + name + "_files"], ecosystem = ecosystem,
                         package_name = select(names), configuration = select(targets), role = select(roles), suppliers = ":native_carriers", target_compatible_with = compatible)
        packages.append(":" + name)
    # These selected-target rows are inputs to owner-wide release assembly. A
    # single target's manifest cannot advertise the complete release asset set.
    for group in ["manifest", "frozen"]:
        name = "native_" + group + "_shipping"
        native.filegroup(name = name + "_files", srcs = [":native_carriers"], output_group = group)
        shipping_package(name = name, owner = extension_identity(sql_name), artifacts = [":" + name + "_files"], ecosystem = "internal",
                         package_name = sql_name + "-native-" + group, configuration = select(targets), role = "extension-release-" + group + "-input", suppliers = ":native_carriers", target_compatible_with = compatible)
        packages.append(":" + name)
    shipping_export(name = "native_shipping_export", packages = packages, qualification = select({
        condition: [":native_carriers_test"] if target.startswith("linux-") else [
            "//build_defs/extensions:desktop_all_final_contract_test",
            "//build_defs/extensions:desktop_all_members_frozen_sql_test",
        ] for condition, target in targets.items()
    }) + additional_qualification, testonly = True, target_compatible_with = compatible)
    native.filegroup(name = "native_carrier_spec", srcs = [":native_carriers"], output_group = "spec")
    smoke_members = native_extension_payload_closure([member])
    dependency_packages = {label.rsplit(":", 1)[0] + ":native_npm_shipping_files": True for label in smoke_members if Label(label) != native.package_relative_label(member)}.keys()
    extension_smoke_plan(name = "native_final_plan", members = smoke_members, fixtures = ["//src/test-fixtures/extensions:sql"])
    plans = []
    for group in ["install", "smoke", "startup"]:
        native.filegroup(name = "native_final_" + group, srcs = [":native_final_plan"], output_group = group)
        plans.append(":native_final_" + group)
    inputs = [":native_carrier_spec", ":native_github_shipping_files", ":native_npm_shipping_files", ":native_cargo_shipping_files", "//src/native/runtime:runtime_payload", "//build_defs/extensions:native_extension_smoke"] + plans
    inputs += [":native_manifest_shipping_files", ":native_frozen_shipping_files"] + dependency_packages
    bun_script_test(name = "native_carriers_test", entry_point = "//build_defs/extensions:native_carriers_installed.test.mts",
                    args = ["$(location %s)" % label for label in inputs],
                    data = inputs + native_extension_carrier_helpers() + native_extension_carrier_legal(sql_name) + ["//src/native/sdks/ts:native_asset_sources", "//build_defs/extensions:native_carriers.mts", "//build_defs/extensions:native_carrier_install_helpers.mts"],
                    target_compatible_with = NATIVE_EXTENSION_LINUX_COMPATIBLE, size = "medium")

def _unit_inputs_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".json")
    metadata = native_external_carrier_metadata("pgtap", "linux-x64-gnu")
    metadata["compiledMember"] = native_external_carrier_metadata("pg_uuidv7", "linux-x64-gnu")
    metadata["postgisMember"] = native_external_carrier_metadata("postgis", "linux-x64-gnu")
    products = dict(PRODUCTS)
    runtime = dict(products["liboliphaunt-native"])
    parts = runtime["version"].split(".")
    runtime["version"] = ".".join(parts[:2] + [str(int(parts[2]) + 1)])
    products["liboliphaunt-native"] = runtime
    metadata["newCoreMember"] = native_external_carrier_metadata("pg_uuidv7", "linux-x64-gnu", products = products)
    ctx.actions.write(output, json.encode(metadata))
    return [DefaultInfo(files = depset([output]))]

native_extension_carrier_unit_inputs = rule(implementation = _unit_inputs_impl)
