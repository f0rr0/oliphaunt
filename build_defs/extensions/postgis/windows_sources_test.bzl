"""Byte proof for declared PostGIS Windows source preparation, without C tools."""

load("@oliphaunt_metadata//:metadata.bzl", "EXTENSION_SOURCES")
load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/native:platform_config.bzl", "NATIVE_WINDOWS_COMPATIBLE")

def _runfile(ctx, file):
    return file.short_path[3:] if file.short_path.startswith("../") else ctx.workspace_name + "/" + file.short_path

def _impl(ctx):
    prepared = ctx.attr.prepared
    specs = prepared[OutputGroupInfo].source_spec.to_list()
    if len(specs) != 1:
        fail("PostGIS Windows source proof requires one declared source spec")
    anchor = ctx.file.anchor
    if not anchor.path.endswith(ctx.attr.anchor_name):
        fail("PostGIS Windows source anchor differs from the pinned source root")
    root = anchor.path[:-len(ctx.attr.anchor_name)]
    inputs, expected, seen = [], [], {}
    for file in ctx.files.srcs + ctx.files.hdrs:
        if file.path in seen:
            continue
        seen[file.path] = True
        if file.is_directory or not file.path.startswith(root):
            fail("PostGIS Windows source proof requires declared pinned regular inputs")
        expected.append({"name": file.path[len(root):], "source": file.path})
        inputs.append(file)
    for target, name in ctx.attr.companions.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory:
            fail("PostGIS Windows companion proof requires one declared regular input")
        expected.append({"name": name, "source": files[0].path})
        inputs.append(files[0])
    outputs = prepared[DefaultInfo].files.to_list() + prepared[CcInfo].compilation_context.headers.to_list()
    files = {file.path: file for file in inputs + outputs + specs + [anchor, ctx.file._pin]}
    source = EXTENSION_SOURCES["postgis"]
    inventory = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(inventory, json.encode({
        "schema": "oliphaunt-postgis-windows-source-test-v1",
        "source": {key: source[key] for key in ["name", "url", "branch", "commit", "source_date_epoch", "extension-control"]},
        "pin": ctx.file._pin.path, "anchor": anchor.path, "spec": specs[0].path,
        "expected": expected,
        "outputs": sorted({file.path: True for file in outputs}.keys()),
        "runfiles": {key: _runfile(ctx, file) for key, file in files.items()},
    }))
    sources = [ctx.file._runner] + ctx.files._helpers
    return bun_test_entrypoint(ctx, ctx.file._runner, [inventory], files.values() + [inventory] + sources,
                               source_files = sources, runfiles_argument = True)

_test = rule(
    implementation = _impl,
    test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "prepared": attr.label(mandatory = True, providers = [CcInfo]),
        "srcs": attr.label_list(mandatory = True, allow_files = True),
        "hdrs": attr.label_list(allow_files = True),
        "anchor": attr.label(mandatory = True, allow_single_file = True),
        "anchor_name": attr.string(mandatory = True),
        "companions": attr.label_keyed_string_dict(allow_files = True),
        "_pin": attr.label(default = "//src/extensions/external/postgis:source.toml", allow_single_file = True),
        "_runner": attr.label(default = "//build_defs/extensions/postgis:windows_sources.test.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = ["//build_defs/extensions:windows_source_inputs.mts", "//build_defs/extensions:windows_source_portability.mts"], allow_files = True),
    }),
)

def postgis_windows_sources_test(name, prepared, srcs, hdrs, anchor, anchor_name, companions):
    """Check the actual source action on the native Bun execution host."""
    _test(name = name, prepared = prepared, srcs = srcs, hdrs = hdrs, anchor = anchor,
          anchor_name = anchor_name, companions = companions,
          args = bun_test_entrypoint_args(name), size = "small", target_compatible_with = NATIVE_WINDOWS_COMPATIBLE)
