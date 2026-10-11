"""One portable pgTAP SQL payload, then canonical Cargo/npm/GitHub envelopes."""

load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action", "bun_script_test")
load("//build_defs/release:identity.bzl", "ReleaseIdentityInfo")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")
load("//build_defs/wasix:cargo.bzl", "RUNTIME_CARGO_HELPERS")
load(":extensions.bzl", "extension_identity")
load(":final_leaf.bzl", "ExtensionFinalLeafInfo")
load(":native_carriers.bzl", "native_extension_carrier_helpers", "native_extension_carrier_legal", "native_external_carrier_metadata")

def wasix_sql_carrier_helpers():
    # Both public canonical writers import the shared extension/runtime contracts.
    return {label: True for label in native_extension_carrier_helpers() + RUNTIME_CARGO_HELPERS}.keys()

def _metadata(sql_name):
    if sql_name != "pgtap":
        fail("only the qualified pgTAP SQL-only WASIX producer is admitted")
    metadata = native_external_carrier_metadata(sql_name, "wasix-portable")
    metadata.pop("runtimeVersion")
    metadata["carriers"] = [row for row in metadata["carriers"] if row["target"] == "wasix-portable"]
    return metadata

def _leaf(spec, ecosystem):
    rows = [row for row in spec["carriers"] if row["ecosystem"] == ecosystem and row["target"] == "wasix-portable" and row["role"] == "portable-leaf"]
    if len(rows) != 1:
        fail("SQL-only WASIX envelope requires exactly its canonical " + ecosystem + " portable leaf")
    return rows[0]

def _carriers_impl(ctx):
    owner = ctx.attr.owner[ReleaseIdentityInfo]
    spec = _metadata(ctx.attr.sql_name)
    if owner.id != spec["product"] or owner.version != spec["version"]:
        fail("SQL-only WASIX member differs from its canonical release owner")
    sql = ctx.attr.sql[DefaultInfo].files.to_list()
    if len(sql) != 1 or not sql[0].is_directory:
        fail("SQL-only WASIX member requires exactly the production SQL TreeArtifact")
    github = ctx.actions.declare_file(spec["product"] + "-" + spec["version"] + "-wasix-portable.tar.zst")
    npm = ctx.actions.declare_file(_leaf(spec, "npm")["name"].replace("@", "").replace("/", "-") + "-" + spec["version"] + ".tgz")
    cargo = ctx.actions.declare_file(_leaf(spec, "cargo")["name"] + "-" + spec["version"] + ".crate")
    manifest = ctx.actions.declare_file(ctx.label.name + "/" + spec["product"] + "-" + spec["version"] + "-manifest.json")
    frozen = ctx.actions.declare_file(ctx.label.name + "/extension-artifacts.json")
    spec.update({"sqlRoot": sql[0].path, "outputs": {"github": github.path, "npm": npm.path, "cargo": cargo.path, "manifest": manifest.path, "frozen": frozen.path}})
    inputs = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(inputs, json.encode(spec))
    leaves = ctx.actions.args()
    leaves.add_all(sql, expand_directories = True)
    leaves.use_param_file("--sql-files=%s", use_always = True)
    leaves.set_param_file_format("multiline")
    bun_file_action(ctx, ctx.file._tool, arguments = [inputs.path, leaves], inputs = sql + [inputs] + ctx.files.legal,
                    source_files = [ctx.file._tool] + ctx.files._helpers + ctx.files.legal,
                    outputs = [github, npm, cargo, manifest, frozen], mnemonic = "WasixSqlExtensionEnvelopes")
    return [DefaultInfo(files = depset([github, npm, cargo, manifest, frozen])),
            ExtensionFinalLeafInfo(product = spec["product"], owner = owner.id, version = owner.version, family = "wasix", target = "wasix-portable", metadata = spec, github = [github], npm = [npm], cargo = [cargo], manifest = manifest, frozen = frozen, spec = inputs, validation = None, receipt = None, origin = None),
            OutputGroupInfo(github = depset([github]), npm = depset([npm]), cargo = depset([cargo]), manifest = depset([manifest]), frozen = depset([frozen]), spec = depset([inputs]), sql = depset(sql))]

_wasix_sql_carriers = rule(implementation = _carriers_impl, toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {"sql_name": attr.string(mandatory = True), "sql": attr.label(mandatory = True, cfg = "exec"),
             "owner": attr.label(mandatory = True, providers = [ReleaseIdentityInfo]), "legal": attr.label_list(allow_files = True),
             "_tool": attr.label(default = "//build_defs/extensions:wasix_carriers.mts", allow_single_file = True),
             "_helpers": attr.label_list(default = wasix_sql_carrier_helpers(), allow_files = True)})

def wasix_sql_extension_carriers(sql_name, sql = ":sql"):
    spec = _metadata(sql_name)
    _wasix_sql_carriers(name = "wasix_carriers", sql_name = sql_name, sql = sql, owner = extension_identity(sql_name, family = "wasix"), legal = native_extension_carrier_legal(sql_name), exec_compatible_with = ["@platforms//os:linux"])
    packages = []
    for ecosystem in ["github", "npm", "cargo", "manifest", "frozen"]:
        name = "wasix_" + ecosystem + "_shipping"
        native.filegroup(name = name + "_files", srcs = [":wasix_carriers"], output_group = ecosystem)
        if ecosystem == "github":
            package_name, role = spec["product"] + "-" + spec["version"] + "-wasix-portable.tar.zst", "github-release-asset"
        elif ecosystem in ["npm", "cargo"]:
            row = _leaf(spec, ecosystem)
            package_name, role = row["name"], row["role"]
        else:
            package_name, role = sql_name + "-wasix-" + ecosystem, "extension-release-" + ecosystem + "-input"
        shipping_package(name = name, owner = extension_identity(sql_name, family = "wasix"), artifacts = [":" + name + "_files"], ecosystem = ecosystem if ecosystem in ["github", "npm", "cargo"] else "internal", package_name = package_name, configuration = "wasix-portable", role = role)
        packages.append(":" + name)
    # This family's selected inputs do not advertise the complete external owner.
    shipping_export(name = "wasix_shipping_export", packages = packages)
    native.filegroup(name = "wasix_carrier_spec", srcs = [":wasix_carriers"], output_group = "spec")
    native.filegroup(name = "wasix_sql_input", srcs = [":wasix_carriers"], output_group = "sql")
    inputs = [":wasix_carrier_spec"] + [":wasix_" + group + "_shipping_files" for group in ["github", "npm", "cargo", "manifest", "frozen"]] + [":wasix_sql_input"]
    bun_script_test(name = "wasix_carriers_test", entry_point = "//build_defs/extensions:wasix_carriers.test.mts", args = ["$(location %s)" % label for label in inputs], data = inputs + ["//build_defs/extensions:wasix_carriers.mts"] + wasix_sql_carrier_helpers() + native_extension_carrier_legal(sql_name), target_compatible_with = ["@platforms//os:linux"], size = "small")

def _unit_inputs_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.write(output, json.encode(_metadata("pgtap")))
    return [DefaultInfo(files = depset([output]))]

wasix_sql_carrier_unit_inputs = rule(implementation = _unit_inputs_impl)
