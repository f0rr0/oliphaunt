"""One final facade/control owner join over original qualified constructor Files."""

load("@oliphaunt_metadata//:metadata.bzl", "EXTENSION_GITHUB_ARTIFACTS", "EXTENSION_RELEASE_METADATA", "PRODUCTS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/release:identity.bzl", "release_identity")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")
load(":declared_final_inputs.bzl", "native_declared_apple_base", "native_extension_declared_final_import")
load(":owner_carriers.bzl", "native_extension_family_carriers", "native_owner_carrier_helpers", "native_owner_carrier_legal", "native_owner_carrier_metadata")

def _runfile(ctx, file):
    return file.short_path[3:] if file.short_path.startswith("../") else ctx.workspace_name + "/" + file.short_path

def _contract_impl(ctx):
    spec = ctx.attr.family[OutputGroupInfo].spec.to_list()
    if len(spec) != 1:
        fail("extension family contract requires its actual construction spec")
    files = depset(ctx.files.legal, transitive = [ctx.attr.family[DefaultInfo].files] + [target[DefaultInfo].files for target in ctx.attr.inputs]).to_list()
    locations = ctx.actions.declare_file(ctx.label.name + ".locations.json")
    ctx.actions.write(locations, json.encode({file.path: _runfile(ctx, file) for file in files}))
    return bun_test_entrypoint(ctx, ctx.file._runner, [spec[0], locations], files + [locations] + ctx.files._helpers,
                               source_files = [ctx.file._runner] + ctx.files._helpers + ctx.files.legal, runfiles_argument = True)

_family_contract_test = rule(implementation = _contract_impl, test = True, toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "family": attr.label(mandatory = True), "inputs": attr.label_list(allow_files = True), "legal": attr.label_list(allow_files = True),
        "_runner": attr.label(default = "//build_defs/extensions:family_contract.test.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = native_owner_carrier_helpers() + ["//build_defs/extensions:owner_carriers.mts", "//tools/release:checksum-manifest.mts"], allow_files = True),
    }))

def _family(name, product, base_carrier_manifest, family = "native"):
    spec = native_owner_carrier_metadata(product, family)
    leaves, wasix_leaves = [], []
    for profile in spec["profiles"]:
        imported = name + "_" + profile["target"].replace("-", "_")
        native_extension_declared_final_import(name = imported, product = product, family = "native", target = profile["target"])
        leaves.append(":" + imported)
    if "wasix" in spec["ownerFamilies"]:
        imported = name + "_wasix_portable"
        native_extension_declared_final_import(name = imported, product = product, family = "wasix", target = "wasix-portable")
        wasix_leaves.append(":" + imported)
    base = base_carrier_manifest if "native" in spec["ownerFamilies"] else None
    if base and spec["runtimeVersion"] != PRODUCTS["liboliphaunt-native"]["version"]:
        native_declared_apple_base(name = name + "_base", version = spec["runtimeVersion"])
        base = ":" + name + "_base"
    native_extension_family_carriers(name = name, product = product, leaves = leaves, wasix_leaves = wasix_leaves,
                                     base_carrier_manifest = base, family = family)
    owner = name + "_owner"
    release_identity(name = owner, product_id = spec["owner"], version = spec["version"])
    rows = [struct(group = "frozen", ecosystem = "internal", name = product + "-" + family + "-release-family", role = "extension-release-family-input")]
    if "native" in spec["ownerFamilies"]:
        for ecosystem in ["npm", "cargo"]:
            facade = [row for row in spec["carriers"] if row["ecosystem"] == ecosystem and row["role"] == "facade" and row["target"] == None]
            if len(facade) != 1:
                fail("extension family requires one canonical " + ecosystem + " facade")
            rows.append(struct(group = ecosystem, ecosystem = ecosystem, name = facade[0]["name"], role = "facade"))
    rows += [struct(group = "control_" + row["kind"], ecosystem = "github", name = row["name"], role = row["role"])
             for row in EXTENSION_GITHUB_ARTIFACTS if row["artifactProduct"] == product and row["owner"] == spec["owner"] and row.get("control", False)]
    packages = []
    for index, row in enumerate(rows):
        output = name + "_files_" + str(index)
        native.filegroup(name = output, srcs = [":" + name], output_group = row.group)
        package = name + "_shipping_" + str(index)
        shipping_package(name = package, owner = ":" + owner, artifacts = [":" + output], ecosystem = row.ecosystem,
                         package_name = row.name, configuration = "portable", role = row.role, suppliers = ":" + name)
        packages.append(":" + package)
    _family_contract_test(name = name + "_contract_test", family = ":" + name,
                     inputs = leaves + wasix_leaves + ([base] if base else []), legal = native_owner_carrier_legal(product), args = bun_test_entrypoint_args(name + "_contract_test"), size = "medium")
    shipping_export(name = name + "_shipping_export", packages = packages,
                    qualification = [":" + name + "_contract_test"], testonly = True)

def native_extension_final_families(base_carrier_manifest):
    """Derive each distribution from the same canonical release metadata once."""
    products = sorted({row["artifactProduct"]: True for row in EXTENSION_RELEASE_METADATA})
    for product in products:
        rows = [row for row in EXTENSION_RELEASE_METADATA if row["artifactProduct"] == product]
        if rows[0]["class"] == "contrib":
            _family("contrib_native_family", product, base_carrier_manifest)
            _family("contrib_wasix_family", product, None, family = "wasix")
        else:
            if len(rows) != 1:
                fail("external family requires its one canonical SQL member")
            _family(rows[0]["sqlName"] + "_family", product, base_carrier_manifest)
