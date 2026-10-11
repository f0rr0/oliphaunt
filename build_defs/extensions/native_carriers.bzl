"""Selected Linux extension final envelopes from their typed member producers."""

load("@oliphaunt_metadata//:metadata.bzl", "EXTENSIONS", "EXTENSION_COMPATIBILITY", "EXTENSION_DEPENDENCIES", "EXTENSION_RECIPES", "EXTENSION_SOURCES", "PRODUCTS", "PUBLICATION_CARRIERS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action", "bun_script_test")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")
load(":extensions.bzl", "ExtensionMemberInfo", "extension_identity")
load(":platforms.bzl", "NATIVE_EXTENSION_COMPATIBLE")
load(":smoke.bzl", "extension_smoke_plan")

_TARGETS = {"//build_defs/native:linux_x86_64": "linux-x64-gnu", "//build_defs/native:linux_aarch64_gnu_2_28": "linux-arm64-gnu"}

def native_extension_carrier_helpers():
    return [
        "//build_defs/extensions:validate_member_payload.mts",
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
    # Each audited license source is checked against its immutable source manifest.
    inputs += [package + "dependencies/" + name + "/source.toml" for name in EXTENSION_DEPENDENCIES.get(sql_name, {})]
    return inputs

def _metadata(sql_name, target):
    product = EXTENSION_SOURCES[sql_name]["product"]
    return {"product": product, "version": PRODUCTS[product]["version"], "sqlName": sql_name, "target": target, "runtimeVersion": PRODUCTS["liboliphaunt-native"]["version"],
            "descriptor": EXTENSIONS[sql_name], "recipe": EXTENSION_RECIPES.get(sql_name, {}), "source": EXTENSION_SOURCES[sql_name],
            "selectedDependencies": sorted([name for name in EXTENSIONS[sql_name].get("dependencies", []) if name in EXTENSIONS]),
            "compatibility": EXTENSION_COMPATIBILITY[sql_name], "carriers": [row for row in PUBLICATION_CARRIERS if row["product"] == product]}

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
    spec = _metadata(member.sql_name, member.configuration)
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
    return [DefaultInfo(files = depset([github, npm, cargo, manifest, frozen])), OutputGroupInfo(github = depset([github]), npm = depset([npm]), cargo = depset([cargo]), manifest = depset([manifest]), frozen = depset([frozen]), spec = depset([inputs]))]

_native_extension_carriers = rule(implementation = _carriers_impl, toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {"member": attr.label(mandatory = True, providers = [ExtensionMemberInfo]), "legal": attr.label_list(allow_files = True),
             "_tool": attr.label(default = "//build_defs/extensions:native_carriers.mts", allow_single_file = True),
             "_helpers": attr.label_list(default = native_extension_carrier_helpers(), allow_files = True)})

def native_external_extension_carriers(sql_name, member = ":native_payload"):
    _native_extension_carriers(name = "native_carriers", member = member, legal = native_extension_carrier_legal(sql_name), target_compatible_with = NATIVE_EXTENSION_COMPATIBLE)
    metadata = {condition: _metadata(sql_name, target) for condition, target in _TARGETS.items()}
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
                         package_name = select(names), configuration = select(_TARGETS), role = select(roles), target_compatible_with = NATIVE_EXTENSION_COMPATIBLE)
        packages.append(":" + name)
    # These selected-target rows are inputs to owner-wide release assembly. A
    # single target's manifest cannot advertise the complete release asset set.
    for group in ["manifest", "frozen"]:
        name = "native_" + group + "_shipping"
        native.filegroup(name = name + "_files", srcs = [":native_carriers"], output_group = group)
        shipping_package(name = name, owner = extension_identity(sql_name), artifacts = [":" + name + "_files"], ecosystem = "internal",
                         package_name = sql_name + "-native-" + group, configuration = select(_TARGETS), role = "extension-release-" + group + "-input", target_compatible_with = NATIVE_EXTENSION_COMPATIBLE)
        packages.append(":" + name)
    shipping_export(name = "native_shipping_export", packages = packages, target_compatible_with = NATIVE_EXTENSION_COMPATIBLE)
    native.filegroup(name = "native_carrier_spec", srcs = [":native_carriers"], output_group = "spec")
    extension_smoke_plan(name = "native_final_plan", members = [member], fixtures = ["//src/test-fixtures/extensions:sql"])
    plans = []
    for group in ["install", "smoke", "startup"]:
        native.filegroup(name = "native_final_" + group, srcs = [":native_final_plan"], output_group = group)
        plans.append(":native_final_" + group)
    inputs = [":native_carrier_spec", ":native_github_shipping_files", ":native_npm_shipping_files", ":native_cargo_shipping_files", "//src/native/runtime:runtime_payload", "//build_defs/extensions:native_extension_smoke"] + plans
    inputs += [":native_manifest_shipping_files", ":native_frozen_shipping_files"]
    bun_script_test(name = "native_carriers_test", entry_point = "//build_defs/extensions:native_carriers_installed.test.mts",
                    args = ["$(location %s)" % label for label in inputs],
                    data = inputs + native_extension_carrier_helpers() + native_extension_carrier_legal(sql_name) + ["//src/native/sdks/ts:native_asset_sources", "//build_defs/extensions:native_carriers.mts"],
                    target_compatible_with = NATIVE_EXTENSION_COMPATIBLE, size = "medium")

def _unit_inputs_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.write(output, json.encode(_metadata("pgtap", "linux-x64-gnu")))
    return [DefaultInfo(files = depset([output]))]

native_extension_carrier_unit_inputs = rule(implementation = _unit_inputs_impl)
