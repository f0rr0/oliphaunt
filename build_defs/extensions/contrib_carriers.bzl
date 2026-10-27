"""Runtime-owned native contrib final envelopes from the canonical distribution."""

load("@oliphaunt_metadata//:metadata.bzl", "CONTRIB_MEMBERS", "CONTRIB_OWNERS", "EXTENSIONS", "EXTENSION_RELEASE_METADATA", "POSTGRES_SOURCE", "PRODUCTS", "PUBLICATION_CARRIERS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action", "bun_script_test")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")
load("//build_defs/release:supplier.bzl", "ShippingSupplierInfo", "merge_shipping_suppliers")
load(":extensions.bzl", "ExtensionMemberInfo", "extension_identity")
load(":final_leaf.bzl", "ExtensionFinalLeafInfo")
load(":native_carriers.bzl", "extension_owner_metadata", "native_extension_carrier_helpers", "native_extension_carrier_legal")
load(":platforms.bzl", "NATIVE_EXTENSION_COMPATIBLE", "NATIVE_EXTENSION_LINUX_COMPATIBLE")
load(":smoke.bzl", "extension_smoke_plan")

_TARGETS = {"//build_defs/native:linux_x86_64": "linux-x64-gnu", "//build_defs/native:linux_aarch64_gnu_2_28": "linux-arm64-gnu", "//build_defs/native:macos_arm64": "macos-arm64", "//build_defs/native:windows_x64": "windows-x64-msvc"}

def native_contrib_carrier_legal():
    return ["//:LICENSE", "//:THIRD_PARTY_NOTICES.md", "//src/third-party/postgres:COPYRIGHT", "//src/third-party/postgres:source.toml", "//src/third-party/openssl:LICENSE.txt", "//src/third-party/openssl:source.toml"]

def native_contrib_carrier_metadata(target, family = "native"):
    rows = [row for row in EXTENSION_RELEASE_METADATA if row["class"] == "contrib"]
    expected = sorted([member["sql-name"] for member in CONTRIB_MEMBERS])
    if sorted([row["sqlName"] for row in rows]) != expected:
        fail("contrib carrier metadata must cover every canonical member exactly once")
    metadata = rows[0]
    product = metadata["artifactProduct"]
    owner = CONTRIB_OWNERS[family]
    compatibility = metadata["compatibility"]
    common = {"product": product, "owner": owner, "version": PRODUCTS[owner]["version"], "runtimeVersion": PRODUCTS[owner]["version"], "target": target,
              "compatibility": {"extension_runtime_contract": compatibility["extensionRuntimeContract"], "native_runtime_product": compatibility["nativeRuntimeProduct"], "native_runtime_version": compatibility["nativeRuntimeVersion"], "postgres_major": compatibility["postgresMajor"], "wasix_runtime_product": compatibility["wasixRuntimeProduct"], "wasix_runtime_version": compatibility["wasixRuntimeVersion"]},
              "source": POSTGRES_SOURCE, "carriers": [row for row in PUBLICATION_CARRIERS if row["product"] == owner and (row["name"] == metadata["npmPackage"] or row["name"].startswith(metadata["npmPackage"] + "-") or row["name"] == metadata["cargoPackage"] or row["name"].startswith(metadata["cargoPackage"] + "-"))]}
    members = []
    for member in CONTRIB_MEMBERS:
        sql_name = member["sql-name"]
        descriptors = [descriptor for descriptor in EXTENSIONS.values() if descriptor["sql-name"] == sql_name]
        if len(descriptors) != 1:
            fail("contrib final carrier requires exactly one canonical SQL descriptor")
        descriptor = descriptors[0]
        spec = dict(common)
        spec.update({"sqlName": sql_name, "contrib": member, "descriptor": descriptor, "recipe": {}, "selectedDependencies": sorted([name for name in descriptor.get("dependencies", []) if name in expected])})
        members.append(spec)
    common.update({"sqlName": "", "descriptor": {}, "recipe": {}, "selectedDependencies": [], "expectedMembers": expected, "members": members, "sourceIdentity": metadata["sourceIdentity"], "ownerMetadata": extension_owner_metadata()})
    return common

def _leaf(spec, ecosystem):
    facades = [row for row in spec["carriers"] if row["ecosystem"] == "npm" and row["target"] == None]
    if len(facades) != 1:
        fail("contrib final carrier requires its unique canonical npm facade")
    name = (facades[0]["name"] if ecosystem == "npm" else spec["product"]) + "-" + spec["target"]
    rows = [row for row in spec["carriers"] if row["ecosystem"] == ecosystem and row["name"] == name and row["target"] == spec["target"]]
    if len(rows) != 1:
        fail("contrib final carrier requires exactly one canonical " + ecosystem + " leaf")
    return rows[0]

def _carriers_impl(ctx):
    typed = [target[ExtensionMemberInfo] for target in ctx.attr.members]
    if not typed:
        fail("contrib final carrier requires all canonical typed member producers")
    spec = native_contrib_carrier_metadata(typed[0].configuration)
    actual = {member.sql_name: member for member in typed}
    if len(actual) != len(typed) or sorted(actual.keys()) != spec["expectedMembers"]:
        fail("contrib final carrier must consume every canonical member exactly once")
    member_inputs = []
    for member in spec["members"]:
        producer = actual[member["sqlName"]]
        if producer.owner != spec["owner"] or producer.configuration != spec["target"]:
            fail("contrib member owner/configuration differs from its bundle")
        member["archive"] = producer.archive.path
        member_inputs += [producer.archive, producer.inventory]
    github = ctx.actions.declare_file(spec["product"] + "-" + spec["version"] + "-native-" + spec["target"] + "-bundle.tar.gz")
    npm = ctx.actions.declare_file(_leaf(spec, "npm")["name"].replace("@", "").replace("/", "-") + "-" + spec["version"] + ".tgz")
    cargo = ctx.actions.declare_directory(ctx.label.name + "/cargo")
    manifest = ctx.actions.declare_file(ctx.label.name + "/" + spec["product"] + "-" + spec["version"] + "-manifest.json")
    frozen = ctx.actions.declare_file(ctx.label.name + "/extension-artifacts.json")
    spec["outputs"] = {"github": github.path, "npm": npm.path, "cargo": cargo.path, "manifest": manifest.path, "frozen": frozen.path}
    inputs = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(inputs, json.encode(spec))
    bun_file_action(ctx, ctx.file._tool, arguments = [inputs.path], inputs = member_inputs + [inputs] + ctx.files.legal,
                    source_files = [ctx.file._tool] + ctx.files._helpers + ctx.files.legal,
                    outputs = [github, npm, cargo, manifest, frozen], mnemonic = "NativeContribEnvelopes")
    suppliers = merge_shipping_suppliers([member[ShippingSupplierInfo] for member in ctx.attr.members])
    return [DefaultInfo(files = depset([github, npm, cargo, manifest, frozen])), suppliers,
            ExtensionFinalLeafInfo(product = spec["product"], owner = spec["owner"], version = spec["version"], family = "native", target = spec["target"], metadata = spec, github = [github], npm = [npm], cargo = [cargo], manifest = manifest, frozen = frozen, spec = inputs, validation = None, receipt = None, origin = None),
            OutputGroupInfo(github = depset([github]), npm = depset([npm]), cargo = depset([cargo]), manifest = depset([manifest]), frozen = depset([frozen]), spec = depset([inputs]))]

_native_contrib_carriers = rule(implementation = _carriers_impl, toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {"members": attr.label_list(mandatory = True, providers = [ExtensionMemberInfo, ShippingSupplierInfo]), "legal": attr.label_list(allow_files = True),
             "_tool": attr.label(default = "//build_defs/extensions:contrib_carriers.mts", allow_single_file = True),
             "_helpers": attr.label_list(default = native_extension_carrier_helpers() + ["//build_defs/extensions:native_carriers.mts", "//:src/extensions/artifacts/packages/tools/bundle-carrier-assets.mts"], allow_files = True)})

def native_contrib_carriers():
    members = [":" + member["id"] + "_native_payload" for member in CONTRIB_MEMBERS]
    _native_contrib_carriers(name = "native_carriers", members = members, legal = native_contrib_carrier_legal(), target_compatible_with = NATIVE_EXTENSION_COMPATIBLE)
    metadata = {condition: native_contrib_carrier_metadata(target) for condition, target in _TARGETS.items()}
    owner = extension_identity(CONTRIB_MEMBERS[0]["sql-name"])
    packages = []
    for ecosystem in ["github", "npm", "cargo"]:
        name = "native_" + ecosystem + "_shipping"
        native.filegroup(name = name + "_files", srcs = [":native_carriers"], output_group = ecosystem)
        names, roles = {}, {}
        for condition, spec in metadata.items():
            if ecosystem == "github":
                names[condition] = spec["product"] + "-" + spec["version"] + "-native-" + spec["target"] + "-bundle.tar.gz"
                roles[condition] = "github-release-asset"
            else:
                row = _leaf(spec, ecosystem)
                names[condition], roles[condition] = row["name"], row["role"]
        shipping_package(name = name, owner = owner, artifacts = [":" + name + "_files"], ecosystem = ecosystem,
                         package_name = select(names), configuration = select(_TARGETS), role = select(roles), suppliers = ":native_carriers", target_compatible_with = NATIVE_EXTENSION_COMPATIBLE)
        packages.append(":" + name)
    for group in ["manifest", "frozen"]:
        name = "native_" + group + "_shipping"
        native.filegroup(name = name + "_files", srcs = [":native_carriers"], output_group = group)
        shipping_package(name = name, owner = owner, artifacts = [":" + name + "_files"], ecosystem = "internal",
                         package_name = "contrib-native-" + group, configuration = select(_TARGETS), role = "extension-release-" + group + "-input", suppliers = ":native_carriers", target_compatible_with = NATIVE_EXTENSION_COMPATIBLE)
        packages.append(":" + name)
    shipping_export(name = "native_shipping_export", packages = packages, qualification = select({
        condition: [":native_carriers_test"] if target.startswith("linux-") else [
            "//build_defs/extensions:desktop_all_final_contract_test",
            "//build_defs/extensions:desktop_all_members_frozen_sql_test",
        ] for condition, target in _TARGETS.items()
    }), testonly = True, target_compatible_with = NATIVE_EXTENSION_COMPATIBLE)
    native.filegroup(name = "native_carrier_spec", srcs = [":native_carriers"], output_group = "spec")
    extension_smoke_plan(name = "native_final_plan", members = [":cube_native_payload", ":pg_trgm_native_payload", "//src/extensions/external/pgtap:native_payload"], fixtures = ["//src/test-fixtures/extensions:sql"])
    plans = []
    for group in ["install", "smoke", "startup"]:
        native.filegroup(name = "native_final_" + group, srcs = [":native_final_plan"], output_group = group)
        plans.append(":native_final_" + group)
    inputs = [":native_carrier_spec", ":native_github_shipping_files", ":native_npm_shipping_files", ":native_cargo_shipping_files", "//src/native/runtime:runtime_payload", "//build_defs/extensions:native_extension_smoke"] + plans + [":native_manifest_shipping_files", ":native_frozen_shipping_files", "//src/extensions/external/pgtap:native_npm_shipping_files"]
    data = inputs + native_extension_carrier_helpers() + native_contrib_carrier_legal() + native_extension_carrier_legal("pgtap") + ["//src/native/sdks/ts:native_asset_sources", "//build_defs/extensions:native_carriers.mts", "//build_defs/extensions:contrib_carriers.mts", "//build_defs/extensions:native_carrier_install_helpers.mts", "//:src/extensions/artifacts/packages/tools/bundle-carrier-assets.mts"]
    bun_script_test(name = "native_carriers_test", entry_point = "//build_defs/extensions:contrib_carriers_installed.test.mts",
                    args = ["$(location %s)" % label for label in inputs],
                    data = {label: True for label in data}.keys(),
                    target_compatible_with = NATIVE_EXTENSION_LINUX_COMPATIBLE, size = "medium")

def _unit_inputs_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.write(output, json.encode(native_contrib_carrier_metadata("linux-x64-gnu")))
    return [DefaultInfo(files = depset([output]))]

native_contrib_carrier_unit_inputs = rule(implementation = _unit_inputs_impl)
