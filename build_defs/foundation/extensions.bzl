"""Use existing manifest pins with the standard native language rules."""

# rules_rust's own extension uses this macro. Pinning the ruleset and testing this
# import keeps the absent version-from-manifest API at this one boundary.
load("@rules_rust//rust/private:repositories.bzl", "rust_register_toolchains", "rust_toolchain_tools_repository")
load("@rules_rust//rust/platform:triple.bzl", "get_host_triple")
load("@aspect_rules_js//npm:repositories.bzl", "npm_import")

def _toolchain_metadata(ctx):
    configurations = []
    for module in ctx.modules:
        if module.tags.configure and not module.is_root:
            fail("Only the root module may configure the repository's language tools")
        configurations.extend(module.tags.configure)
    if len(configurations) != 1:
        fail("Exactly one root language toolchain metadata import is required")
    return json.decode(ctx.read(configurations[0].metadata))

def _languages_impl(ctx):
    data = _toolchain_metadata(ctx)
    rust_register_toolchains(
        hub_name = "rust_toolchains",
        versions = [data["rust"]],
        edition = data["edition"],
        extra_target_triples = data["rust_targets"],
    )
    for name, key in [("query_types_node", "types_node"), ("query_undici_types", "undici_types")]:
        package = data[key]
        npm_import(
            name = name,
            package = package["package"],
            version = package["version"],
            integrity = package["integrity"],
            lifecycle_hooks = [],
        )
    return ctx.extension_metadata(
        root_module_direct_deps = ["rust_toolchains", "query_types_node", "query_undici_types"],
        root_module_direct_dev_deps = [],
        reproducible = True,
    )

def _rust_host_tools_impl(ctx):
    data = _toolchain_metadata(ctx)
    host = get_host_triple(ctx)
    rust_toolchain_tools_repository(
        name = "rust_host_tools",
        exec_triple = host.str,
        target_triple = host.str,
        version = data["rust"],
        edition = data["edition"],
    )
    return ctx.extension_metadata(
        root_module_direct_deps = ["rust_host_tools"],
        root_module_direct_dev_deps = [],
        reproducible = True,
    )

_CONFIGURE_TAG = tag_class(attrs = {"metadata": attr.label(mandatory = True)})

languages = module_extension(
    implementation = _languages_impl,
    tag_classes = {"configure": _CONFIGURE_TAG},
)

# Like rules_rust's own host-tools extension, acquisition follows the host.
# Language toolchain registration and npm imports above remain host-independent.
rust_host_tools = module_extension(
    implementation = _rust_host_tools_impl,
    tag_classes = {"configure": _CONFIGURE_TAG},
    os_dependent = True,
    arch_dependent = True,
)
