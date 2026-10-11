"""Deterministic public source crates from authored manifests and native files."""

load("@native_cargo_metadata//:cargo.bzl", "CARGO")
load("@oliphaunt_metadata//:metadata.bzl", "PRODUCTS", "PUBLICATION_CARRIERS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")

_RUST_TOOLCHAIN = "@rules_rust//rust:toolchain"

def _source_impl(ctx):
    inputs = [ctx.file.manifest, ctx.file.workspace_manifest, ctx.file._packager] + ctx.files._helpers
    entries = {}
    for target, destination in ctx.attr.entries.items():
        for file in target[DefaultInfo].files.to_list():
            entry = destination
            if destination.endswith("/"):
                prefix = target.label.package + "/"
                if not file.short_path.startswith(prefix):
                    fail("source archive file is outside its declared package: " + file.short_path)
                entry += file.short_path[len(prefix):]
            if entry in entries:
                fail("duplicate source archive entry " + entry)
            entries[entry] = file.path
            inputs.append(file)
    specification = ctx.actions.declare_file(ctx.label.name + ".entries.json")
    metadata = ctx.actions.declare_file(ctx.label.name + ".metadata.json")
    ctx.actions.write(specification, json.encode(entries))
    ctx.actions.write(metadata, ctx.attr.metadata)
    output = ctx.actions.declare_file(ctx.attr.out)
    cargo = ctx.toolchains[_RUST_TOOLCHAIN].cargo
    if not cargo:
        fail("Conventional Cargo source inventory requires the pinned Cargo toolchain")
    args = ctx.actions.args()
    args.add_all([output, ctx.file.manifest, ctx.file.workspace_manifest, specification, metadata, cargo])
    # Enumeration needs only Cargo itself, not a compiled target sysroot. It is
    # offline metadata; all archive construction remains this bounded action.
    bun_file_action(ctx, entry_point = ctx.file._packager, arguments = [args], inputs = depset(inputs + [specification, metadata, cargo]), source_files = [ctx.file._packager] + ctx.files._helpers, outputs = [output], mnemonic = "CargoSourceEnvelope")
    return [DefaultInfo(files = depset([output]))]

_cargo_source = rule(
    implementation = _source_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS + [_RUST_TOOLCHAIN],
    attrs = {
        "entries": attr.label_keyed_string_dict(allow_files = True),
        "manifest": attr.label(allow_single_file = True, mandatory = True),
        "workspace_manifest": attr.label(default = Label("//:Cargo.toml"), allow_single_file = True),
        "metadata": attr.string(mandatory = True),
        "out": attr.string(mandatory = True),
        "_packager": attr.label(default = Label("//build_defs/languages:source-package.mts"), allow_single_file = True),
        "_helpers": attr.label_list(default = [Label("//:tools/packaging/cargo-manifest.mts"), Label("//build_defs/query:package.mts"), Label("//:tools/packaging/archive-directory.mts"), Label("//:tools/packaging/portable-archive.mts"), Label("//:tools/packaging/rust-native-targets.mts")], allow_files = True),
    },
)

def cargo_source_package(product, fixtures = "", native_sdk = False, cargo_facts = CARGO, workspace_manifest = "//:Cargo.toml"):
    facts = cargo_facts[native.package_name()]
    descriptor = PRODUCTS[product]
    if "crates:" + facts["name"] not in descriptor.get("registry_packages", []):
        fail("Cargo source package is not declared by its release owner: " + facts["name"])
    carriers = [row for row in PUBLICATION_CARRIERS if row["product"] == product and row["ecosystem"] == "cargo" and row["name"] == facts["name"] and row["target"] == None]
    if len(carriers) != 1:
        fail("Canonical Cargo source package identity is not unique: " + facts["name"])
    dependencies = dict(facts["dependencies"])
    dependencies.update(facts["build_dependencies"])
    dependencies.update(facts["dev_dependencies"])
    for table in facts["target_dependencies"].values():
        dependencies.update(table.get("dependencies", {}))
    dependency_owners = {}
    for name, declaration in dependencies.items():
        package_name = declaration.get("package", name) if type(declaration) == "dict" else name
        for owner, candidate in PRODUCTS.items():
            if "crates:" + package_name in candidate.get("registry_packages", []):
                dependency_owners[package_name] = owner
    metadata = {"product": product, "version": descriptor["version"], "compatibility": descriptor["compatibility_versions"], "dependencyOwners": dependency_owners}
    if native_sdk:
        metadata["nativeArtifacts"] = PRODUCTS["liboliphaunt-native"]["cargo_artifacts"]
        metadata["brokerArtifacts"] = PRODUCTS["oliphaunt-broker"]["cargo_artifacts"]
    # Cargo owns public include/exclude semantics. Stage the complete declared
    # package tree so newly added source directories cannot disappear silently.
    # Nested Bazel/Cargo packages have their own construction boundary.
    # Source checkout fixture symlinks and staged package fixture copies occupy
    # the same paths. The canonical fixture target supplies those bytes once.
    sources = native.glob(["**"], exclude = [fixtures + "**"] if fixtures else [], allow_empty = True)
    entries = {file: file for file in sources}
    for name in ["LICENSE", "THIRD_PARTY_NOTICES.md"]:
        if name not in entries:
            entries["//:" + name] = name
    if fixtures:
        entries["//src/test-fixtures:rust_fixtures"] = fixtures
    _cargo_source(name = "crate", manifest = "Cargo.toml", workspace_manifest = workspace_manifest, entries = entries, metadata = json.encode(metadata), out = facts["name"] + ".crate")
    shipping_package(name = "shipping_package", owner = "@oliphaunt_metadata//:product_" + product, artifacts = [":crate"], ecosystem = "cargo", package_name = facts["name"], configuration = "source", role = carriers[0]["role"])
    shipping_export(name = "shipping_export", packages = [":shipping_package"])
