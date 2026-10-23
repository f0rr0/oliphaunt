"""Keep napi's conventional noop feature confined to Rust unit tests."""

load("@cargo_crates//:defs.bzl", "crate_deps")
load("@rules_rust//rust:defs.bzl", "rust_common", "rust_library")

def _napi_dependencies_impl(ctx):
    return [rust_common.crate_group_info(dep_variant_infos = ctx.attr.library[rust_common.crate_info].deps)]

_napi_dependencies = rule(
    implementation = _napi_dependencies_impl,
    attrs = {"library": attr.label(mandatory = True, providers = [rust_common.crate_info])},
)

def napi_noop_library():
    # crate_universe appends this call after its generated public library.
    _napi_dependencies(name = "napi_noop_dependencies", library = ":napi", testonly = True)
    attributes = dict(native.existing_rule("napi"))
    attributes.pop("kind")
    # The original library forwards stock platform compatibility through the group.
    # Copying its selector would lose the foreign @platforms root-package label.
    attributes.pop("target_compatible_with", None)
    if not attributes.get("restricted_to"):
        attributes.pop("restricted_to", None)
    attributes["name"] = "napi_noop"
    attributes["crate_name"] = "napi"
    attributes["crate_features"] = list(attributes["crate_features"]) + ["noop"]
    attributes["testonly"] = True
    attributes["visibility"] = ["//visibility:public"]
    # existing_rule loses foreign repositories for labels in the root package.
    # Forward the selected typed dependencies instead of its converted strings.
    attributes["deps"] = [":napi_noop_dependencies"]
    rust_library(**attributes)

def napi_unit_crate_deps(deps, package_name = None):
    return [Label("@cargo_crates//:napi_noop") if name == "napi" else crate_deps([name], package_name = package_name)[0] for name in deps]
