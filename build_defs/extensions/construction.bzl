"""Complete desktop member construction coverage, separate from SQL lifecycle."""

load("@oliphaunt_metadata//:metadata.bzl", "CONTRIB_MEMBERS", "CONTRIB_OWNERS", "EXTENSIONS", "EXTENSION_SOURCES", "PRODUCTS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")
load(":extensions.bzl", "ExtensionMemberInfo", "extension_default_version")
load(":platforms.bzl", "NATIVE_EXTENSION_COMPATIBLE", "NATIVE_EXTENSION_CONFIGURATION")

def _desktop_members():
    # PostGIS still needs its platform-specific dependency/header recipe.
    descriptors = {row["sql-name"]: row for row in EXTENSIONS.values() if row["sql-name"] != "postgis"}
    if len(descriptors) != len(EXTENSIONS) - 1 or "postgis" not in EXTENSION_SOURCES:
        fail("desktop construction requires unique canonical members and the explicit PostGIS exclusion")
    result = []
    for name in sorted(descriptors.keys()):
        descriptor = descriptors[name]
        if descriptor["source-kind"] == "postgres-contrib":
            matches = [member for member in CONTRIB_MEMBERS if member["sql-name"] == name]
            if len(matches) != 1:
                fail("desktop construction lacks a unique contrib member: " + name)
            owner = CONTRIB_OWNERS["native"]
            label = "//src/extensions/contrib:" + matches[0]["id"] + "_native_payload"
        else:
            owner = EXTENSION_SOURCES[name]["product"]
            label = "//" + PRODUCTS[owner]["path"] + ":native_payload"
        result.append(struct(name = name, owner = owner, label = label, descriptor = descriptor))
    return result

def _construction_test_impl(ctx):
    expected = _desktop_members()
    selected = {}
    for target in ctx.attr.members:
        member = target[ExtensionMemberInfo]
        if member.sql_name in selected:
            fail("desktop construction repeats member: " + member.sql_name)
        selected[member.sql_name] = target
    if sorted(selected.keys()) != [row.name for row in expected]:
        fail("desktop construction must request every canonical desktop member exactly once")
    archives = []
    rows = []
    for row in expected:
        target = selected[row.name]
        member = target[ExtensionMemberInfo]
        if target.label != Label(row.label) or member.owner != row.owner or member.configuration != ctx.attr.configuration:
            fail("desktop construction member differs from canonical label, owner, or configuration: " + row.name)
        module = row.descriptor.get("native-module-file", "")
        if module:
            if not module.endswith(".so"):
                fail("canonical desktop module must declare its native .so stem")
            module = module[:-3] + {"macos-arm64": ".dylib", "windows-x64-msvc": ".dll"}.get(ctx.attr.configuration, ".so")
        rows.append({
            "sql_name": row.name,
            "label": row.label,
            "archive": member.archive.path,
            "inventory": member.inventory.path,
            "owner": row.owner,
            "version": PRODUCTS[row.owner]["version"],
            "source_kind": row.descriptor["source-kind"],
            "default_version": extension_default_version(row.name),
            "creates_extension": row.descriptor["lifecycle"]["create-extension"],
            "module_file": module,
        })
        archives.append(member.archive)
    inventory = ctx.actions.declare_file(ctx.label.name + ".inventory.json")
    ctx.actions.write(inventory, json.encode({
        "schema": "oliphaunt-desktop-extension-construction-v1",
        "configuration": ctx.attr.configuration,
        "excluded": ["postgis"],
        "members": rows,
    }))
    sources = [ctx.file._runner] + ctx.files._helpers
    return bun_test_entrypoint(ctx, ctx.file._runner, [inventory] + archives, [inventory] + archives + sources, source_files = sources) + [OutputGroupInfo(inventory = depset([inventory]))]

_desktop_members_construction_test = rule(
    implementation = _construction_test_impl,
    test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "members": attr.label_list(mandatory = True, providers = [ExtensionMemberInfo]),
        "configuration": attr.string(mandatory = True, values = ["linux-x64-gnu", "linux-arm64-gnu", "macos-arm64", "windows-x64-msvc"]),
        "_runner": attr.label(default = "//build_defs/extensions:construction.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = [
            "//build_defs/extensions:validate_member_payload.mts",
            "//:tools/packaging/portable-archive.mts",
            "//:tools/packaging/platform-binary-contract.mts",
            "//:tools/packaging/windows-vc-runtime-closure.mts",
            "//:tools/packaging/windows-vc-runtime-policy.json",
            "//tools/release:platform-compatibility-policy.mts",
            "//:src/extensions/artifacts/native/tools/stage-windows-binary-contract.mts",
        ], allow_files = True),
    }),
)

def desktop_members_construction_test(name, **kwargs):
    """One test fails if any supported member is absent or invalid."""
    _desktop_members_construction_test(
        name = name,
        members = desktop_member_payloads(),
        configuration = NATIVE_EXTENSION_CONFIGURATION,
        args = bun_test_entrypoint_args(name),
        target_compatible_with = NATIVE_EXTENSION_COMPATIBLE,
        **kwargs
    )

def desktop_member_payloads():
    """Actual archive roots for the canonical desktop construction slice."""
    return [row.label for row in _desktop_members()]

def desktop_member_inventory():
    """Canonical identities shared by member and final-carrier qualification."""
    return _desktop_members()
