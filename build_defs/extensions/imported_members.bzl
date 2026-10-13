"""Private runtime sidecars from original qualified extension owner Files."""

load("@oliphaunt_metadata//:metadata.bzl", "EXTENSION_RELEASE_METADATA", "NATIVE_CURRENT_ARTIFACTS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")
load(":construction.bzl", "desktop_member_inventory", "desktop_member_payloads")
load(":declared_final_inputs.bzl", "native_extension_declared_final_import")
load(":extensions.bzl", "ExtensionMemberInfo")
load(":final_leaf.bzl", "ExtensionFinalLeafInfo")
load(":owner_carriers.bzl", "native_final_leaf_files", "native_final_leaf_input", "native_owner_carrier_helpers", "native_owner_carrier_legal")

_LINUX_X64 = ["@platforms//os:linux", "@platforms//cpu:x86_64"]
_ImportedMembersInfo = provider(fields = ["members"])

def _import_members_impl(ctx):
    leaf = ctx.attr.leaf[ExtensionFinalLeafInfo]
    if leaf.family != "native" or leaf.target != "linux-x64-gnu" or not leaf.validation or not hasattr(leaf, "original_files") or not leaf.original_files:
        fail("Rust runtime extensions require validated original Linux x64 final Files")
    names = sorted([member["sqlName"] for member in leaf.metadata["members"]])
    if ctx.attr.sql_names != names or len({name: True for name in names}) != len(names):
        fail("imported runtime members must cover their exact canonical owner")
    outputs, members, rows = [], {}, []
    for name in names:
        archive = ctx.actions.declare_file(ctx.label.name + "/" + name + ".tar.gz")
        inventory = ctx.actions.declare_file(ctx.label.name + "/" + name + ".inventory.json")
        outputs += [archive, inventory]
        rows.append({"sqlName": name, "archive": archive.path, "inventory": inventory.path})
        members[name] = ExtensionMemberInfo(sql_name = name, owner = leaf.owner, configuration = leaf.target,
                                           archive = archive, inventory = inventory)
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({"members": rows, "configuration": leaf.target,
        "owner": leaf.owner, "version": leaf.version, "canonical": leaf.metadata,
        "leaf": native_final_leaf_input(leaf)}))
    bun_file_action(ctx, ctx.file._runner, arguments = [spec.path],
                    inputs = native_final_leaf_files(leaf) + [spec],
                    source_files = [ctx.file._runner] + ctx.files._helpers + ctx.files.legal,
                    outputs = outputs, mnemonic = "ImportNativeRuntimeExtensionMembers")
    return [DefaultInfo(files = depset(outputs)), _ImportedMembersInfo(members = members)]

_import_members = rule(implementation = _import_members_impl, toolchains = BUN_SOURCE_TOOLCHAINS, attrs = {
    "leaf": attr.label(mandatory = True, providers = [ExtensionFinalLeafInfo]),
    "sql_names": attr.string_list(mandatory = True),
    "legal": attr.label_list(allow_files = True),
    "_runner": attr.label(default = "//build_defs/extensions:imported_member.mts", allow_single_file = True),
    "_helpers": attr.label_list(default = native_owner_carrier_helpers() + [
        "//build_defs/extensions:owner_carriers.mts", "//build_defs/extensions:member_payload.mts",
    ], allow_files = True),
})

def _member_impl(ctx):
    member = ctx.attr.members[_ImportedMembersInfo].members[ctx.attr.sql_name]
    return [DefaultInfo(files = depset([member.archive, member.inventory])), member,
            OutputGroupInfo(archive = depset([member.archive]), inventory = depset([member.inventory]))]

_member = rule(implementation = _member_impl, attrs = {
    "members": attr.label(mandatory = True, providers = [_ImportedMembersInfo]),
    "sql_name": attr.string(mandatory = True),
})

def desktop_runtime_member_payloads(name, include_postgis = False):
    """Keep construction local; late runtime qualification consumes original Files."""
    if NATIVE_CURRENT_ARTIFACTS == None:
        return desktop_member_payloads(include_postgis)
    products = {row["sqlName"]: row["artifactProduct"] for row in EXTENSION_RELEASE_METADATA}
    rows = desktop_member_inventory(include_postgis)
    groups = {}
    for row in rows:
        product = products[row.name]
        if product not in groups:
            groups[product] = []
        groups[product].append(row.name)
    labels = {}
    for product, names in groups.items():
        group = name + "_" + product.replace("-", "_")
        native_extension_declared_final_import(name = group + "_original", product = product,
            family = "native", target = "linux-x64-gnu", testonly = True, target_compatible_with = _LINUX_X64)
        _import_members(name = group, leaf = ":" + group + "_original", sql_names = sorted(names), legal = native_owner_carrier_legal(product),
                        testonly = True, target_compatible_with = _LINUX_X64)
        for sql_name in names:
            member = name + "_" + sql_name
            _member(name = member, members = ":" + group, sql_name = sql_name,
                    testonly = True, target_compatible_with = _LINUX_X64)
            labels[sql_name] = ":" + member
    return [labels[row.name] for row in rows]
