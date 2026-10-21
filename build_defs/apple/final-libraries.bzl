"""Regular final archive members feed the maintained C linker directly."""
load("@oliphaunt_metadata//:metadata.bzl", "EXTENSIONS", "EXTENSION_RELEASE_METADATA", "NATIVE_MOBILE_COMPONENT_CLOSURES")
load("@rules_cc//cc:defs.bzl", "cc_import", "cc_library")
load("//build_defs/extensions:final_leaf.bzl", "ExtensionFinalLeafInfo", "NativeAppleBaseInfo")
load("//build_defs/extensions:declared_final_inputs.bzl", "native_extension_declared_final_import")
load("//build_defs/extensions:owner_carriers.bzl", "native_owner_carrier_helpers")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")

def _archive_impl(ctx):
    leaf = ctx.attr.leaf[ExtensionFinalLeafInfo]
    base = ctx.attr.base[NativeAppleBaseInfo]
    if leaf.family != "native" or leaf.target != "ios-xcframework" or leaf.metadata["runtimeVersion"] != base.version:
        fail("The linked final carrier must hold the app's exact native requirement")
    members = leaf.metadata.get("members", [leaf.metadata])
    output = ctx.actions.declare_file(ctx.label.name + ".a")
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    validation = [leaf.validation] if leaf.validation else []
    ctx.actions.write(specification, json.encode({"leaf": {"product": leaf.product, "owner": leaf.owner, "version": leaf.version,
        "runtimeVersion": leaf.metadata["runtimeVersion"], "sqlNames": sorted([member["sqlName"] for member in members]),
        "github": [file.path for file in leaf.github], "frozen": leaf.frozen.path},
        "runtimeVersion": base.version, "sqlName": ctx.attr.sql_name, "kind": ctx.attr.kind,
        "identity": ctx.attr.identity, "slice": ctx.attr.slice, "output": output.path}))
    bun_file_action(ctx, ctx.file._runner, arguments = [specification.path],
        inputs = leaf.github + [leaf.frozen, base.file, specification] + validation,
        source_files = [ctx.file._runner] + ctx.files._helpers,
        outputs = [output], mnemonic = "FinalIosCarrierLibrary")
    return [DefaultInfo(files = depset([output]))]

_archive = rule(implementation = _archive_impl, toolchains = BUN_SOURCE_TOOLCHAINS, attrs = {
    "leaf": attr.label(mandatory = True, providers = [ExtensionFinalLeafInfo], cfg = "exec"),
    "base": attr.label(mandatory = True, providers = [NativeAppleBaseInfo]),
    "sql_name": attr.string(mandatory = True), "identity": attr.string(mandatory = True),
    "kind": attr.string(mandatory = True, values = ["ios-xcframework", "ios-dependency-xcframework"]),
    "slice": attr.string(mandatory = True),
    "_runner": attr.label(default = Label("//build_defs/apple:final-libraries.mts"), allow_single_file = True),
    "_helpers": attr.label_list(default = native_owner_carrier_helpers() + [Label("//build_defs/native/apple:static-carrier-consumer.mts"), Label("//build_defs/native/apple:framework_helpers"), Label("//src/native/sdks/swift:generator_sources")], allow_files = True),
})

def expo_ios_final_libraries(name, extensions, base):
    native.config_setting(name = name + "_simulator", constraint_values = ["@apple_support//constraints:simulator"])
    slice = select({":" + name + "_simulator": "ios-arm64-simulator", "//conditions:default": "ios-arm64"})
    rows = {row["sqlName"]: row for row in EXTENSION_RELEASE_METADATA if row["sqlName"] in extensions}
    leaves = {}
    for product in sorted({row["artifactProduct"]: True for row in rows.values()}):
        imported = name + "_" + product.replace("-", "_") + "_original"
        native_extension_declared_final_import(name = imported, product = product, family = "native", target = "ios-xcframework")
        leaves[product] = ":" + imported
    descriptors = {row["sql-name"]: row for row in EXTENSIONS.values()}
    units = {}
    for sql_name in extensions:
        row = rows[sql_name]
        leaf = leaves[row["artifactProduct"]]
        # The canonical final manifest owns each extension/dependency role.
        module = descriptors[sql_name].get("native-module-file")
        if not module:
            continue
        stem = module[:-3]
        units["extension_" + stem] = (leaf, sql_name, "ios-xcframework", stem)
        for identity in NATIVE_MOBILE_COMPONENT_CLOSURES[sql_name]["ios-xcframework"]["linkUnits"]:
            units["dependency_" + identity] = (leaf, sql_name, "ios-dependency-xcframework", identity)
    imports = []
    for unit, (leaf, sql_name, kind, identity) in sorted(units.items()):
        archive = name + "_" + unit.replace("-", "_")
        _archive(name = archive + "_archive", leaf = leaf, base = base, sql_name = sql_name, kind = kind, identity = identity, slice = slice)
        cc_import(name = archive, static_library = ":" + archive + "_archive", alwayslink = True)
        imports.append(":" + archive)
    cc_library(name = name, deps = imports)
    return leaves.values()
