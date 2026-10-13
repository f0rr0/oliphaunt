"""Deterministic public source crates from authored manifests and native files."""

load("@native_cargo_metadata//:cargo.bzl", "CARGO")
load("@oliphaunt_metadata//:metadata.bzl", "PREPARED_NATIVE_SELECTED_PRODUCTS", "PRODUCTS", "PUBLICATION_CARRIERS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_file_action", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")
load("//build_defs/release:supplier.bzl", "shipping_suppliers")

_RUST_TOOLCHAIN = "@rules_rust//rust:toolchain"
CargoSourceInfo = provider(fields = ["archive", "manifest", "workspace_manifest", "entries", "metadata"])
_SOURCE_HELPERS = [Label("//:tools/packaging/cargo-manifest.mts"), Label("//:tools/packaging/cargo-source-package.mts"), Label("//:tools/packaging/package-archive.mts"), Label("//:tools/packaging/archive-directory.mts"), Label("//:tools/packaging/portable-archive.mts"), Label("//:tools/packaging/release-notices.mts"), Label("//:tools/packaging/release-directory-safety.mts"), Label("//:tools/packaging/rust-native-targets.mts")]

def _runfile(ctx, file):
    return file.short_path[3:] if file.short_path.startswith("../") else ctx.workspace_name + "/" + file.short_path

def _source_impl(ctx):
    inputs = [ctx.file.manifest, ctx.file.workspace_manifest, ctx.file._packager] + ctx.files._helpers
    entries = {}
    entry_files = {}
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
            entry_files[entry] = file
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
    return [DefaultInfo(files = depset([output])), CargoSourceInfo(archive = output, manifest = ctx.file.manifest, workspace_manifest = ctx.file.workspace_manifest, entries = entry_files, metadata = metadata)]

def _source_contract_impl(ctx):
    rust = ctx.toolchains[_RUST_TOOLCHAIN]
    if not rust.cargo:
        fail("Source consumer metadata requires the pinned Cargo toolchain")
    packages = []
    files = rust.all_files.to_list() + [ctx.file._runner] + ctx.files._helpers
    for target in ctx.attr.packages:
        source = target[CargoSourceInfo]
        packages.append({
            "archive": _runfile(ctx, source.archive),
            "manifest": _runfile(ctx, source.manifest),
            "workspace": _runfile(ctx, source.workspace_manifest),
            "metadata": _runfile(ctx, source.metadata),
            "entries": {name: _runfile(ctx, file) for name, file in source.entries.items()},
        })
        files += [source.archive, source.manifest, source.workspace_manifest, source.metadata] + source.entries.values()
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode({"packages": packages, "cargo": _runfile(ctx, rust.cargo), "rustc": _runfile(ctx, rust.rustc)}))
    return bun_test_entrypoint(ctx, ctx.file._runner, [specification], files + [specification], source_files = [ctx.file._runner] + ctx.files._helpers, runfiles_argument = True)

_cargo_source_contract_test = rule(
    implementation = _source_contract_impl,
    test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS + [_RUST_TOOLCHAIN],
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "packages": attr.label_list(providers = [CargoSourceInfo], mandatory = True),
        "_runner": attr.label(default = Label("//build_defs/languages:source-contract.mts"), allow_single_file = True),
        "_helpers": attr.label_list(default = _SOURCE_HELPERS + [Label("//build_defs/languages:source-package.mts"), Label("//:tools/packaging/cargo-dependencies.mts")], allow_files = True),
    }),
)

def cargo_source_contract_test(name, **kwargs):
    _cargo_source_contract_test(name = name, args = bun_test_entrypoint_args(name), **kwargs)

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
        "_helpers": attr.label_list(default = _SOURCE_HELPERS, allow_files = True),
    },
)

def cargo_source_package(product, fixtures = "", native_sdk = False, cargo_facts = CARGO, workspace_manifest = "//:Cargo.toml", qualification = []):
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
        # Source SDKs carry the repository's source notice. A package-local
        # runtime notice belongs to compiled carriers, not this source crate.
        entries.pop(name, None)
        entries["//:" + name] = name
    if fixtures:
        entries["//src/test-fixtures:rust_fixtures"] = fixtures
    _cargo_source(name = "crate", manifest = "Cargo.toml", workspace_manifest = workspace_manifest, entries = entries, metadata = json.encode(metadata), out = facts["name"] + ".crate")
    # This envelope contains authored source and conventional requirements.
    # Its compile/test dependencies are not incorporated compiled carrier Files.
    shipping_suppliers(name = "source_suppliers", inputs = [])
    shipping_package(name = "shipping_package", owner = "@oliphaunt_metadata//:product_" + product, artifacts = [":crate"], ecosystem = "cargo", package_name = facts["name"], configuration = "source", role = carriers[0]["role"], suppliers = ":source_suppliers")
    common_consumer = "//build_defs/languages/installed:consumer_test"
    if product == "oliphaunt-rust" and product in PREPARED_NATIVE_SELECTED_PRODUCTS and common_consumer in qualification:
        qualification = qualification + ["//build_defs/languages/installed:consumer_minimum_test"]
    shipping_export(name = "shipping_export", packages = [":shipping_package"], qualification = qualification, testonly = True)
