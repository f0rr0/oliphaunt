"""Complete desktop member construction coverage, separate from SQL lifecycle."""

load("@oliphaunt_metadata//:metadata.bzl", "CONTRIB_MEMBERS", "CONTRIB_OWNERS", "EXTENSIONS", "EXTENSION_SOURCES", "PRODUCTS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")
load(":extensions.bzl", "ExtensionMemberInfo", "extension_default_version")
load(":platforms.bzl", "NATIVE_EXTENSION_COMPATIBLE", "NATIVE_EXTENSION_CONFIGURATION")

def _desktop_members(include_postgis = False):
    # The independently selected PostGIS dependency recipe requires its own
    # complete host qualification; the existing bounded cohort stays unchanged.
    descriptors = {row["sql-name"]: row for row in EXTENSIONS.values() if include_postgis or row["sql-name"] != "postgis"}
    if len(descriptors) != len(EXTENSIONS) - (0 if include_postgis else 1) or "postgis" not in EXTENSION_SOURCES:
        fail("desktop construction requires unique canonical members and explicit PostGIS selection")
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
    expected = _desktop_members(ctx.attr.include_postgis)
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
    plan = {
        "schema": "oliphaunt-desktop-extension-construction-v1",
        "configuration": ctx.attr.configuration,
        "excluded": [] if ctx.attr.include_postgis else ["postgis"],
        "members": rows,
    }
    if ctx.attr.include_postgis:
        plan["include_postgis"] = True
    ctx.actions.write(inventory, json.encode(plan))
    sources = [ctx.file._runner] + ctx.files._helpers
    return bun_test_entrypoint(ctx, ctx.file._runner, [inventory] + archives, [inventory] + archives + sources, source_files = sources) + [OutputGroupInfo(inventory = depset([inventory]))]

_desktop_members_construction_test = rule(
    implementation = _construction_test_impl,
    test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "members": attr.label_list(mandatory = True, providers = [ExtensionMemberInfo]),
        "include_postgis": attr.bool(),
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

def desktop_members_construction_test(name, include_postgis = False, **kwargs):
    """One test fails if any supported member is absent or invalid."""
    _desktop_members_construction_test(
        name = name,
        members = desktop_member_payloads(include_postgis),
        include_postgis = include_postgis,
        configuration = NATIVE_EXTENSION_CONFIGURATION,
        args = bun_test_entrypoint_args(name),
        target_compatible_with = NATIVE_EXTENSION_COMPATIBLE,
        **kwargs
    )

def desktop_member_payloads(include_postgis = False):
    """Actual archive roots for the canonical desktop construction slice."""
    return [row.label for row in _desktop_members(include_postgis)]

def desktop_member_inventory(include_postgis = False):
    """Canonical identities shared by member and final-carrier qualification."""
    return _desktop_members(include_postgis)
