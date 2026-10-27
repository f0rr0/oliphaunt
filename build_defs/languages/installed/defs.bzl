"""Closed checkout-composition installed qualification, separate from admission."""

load("@rules_cc//cc:find_cc_toolchain.bzl", "use_cc_toolchain")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/languages:cargo-toolchain.bzl", "cargo_test_toolchain")
load("@oliphaunt_metadata//:metadata.bzl", "COMPLETED_SUPPLIER_ARTIFACTS", "NATIVE_CURRENT_ARTIFACTS", "PREPARED_NATIVE_SELECTED_PRODUCTS", "PRODUCTS", "PUBLICATION_CARRIERS")
load("@native_cargo_metadata//:cargo.bzl", "CARGO")

_RUST = "@rules_rust//rust:toolchain_type"

def _runfile(ctx, file):
    return file.short_path[3:] if file.short_path.startswith("../") else ctx.workspace_name + "/" + file.short_path

def cargo_source_owners(names):
    """Owner versions of only the explicitly declared Cargo source archives."""
    result = {}
    for name in names:
        rows = [row for row in PUBLICATION_CARRIERS if row["ecosystem"] == "cargo" and row["name"] == name and row["target"] == None]
        if len(rows) != 1:
            fail("source archive needs one canonical Cargo owner: " + name)
        product = rows[0]["product"]
        result[name] = {"product": product, "version": PRODUCTS[product]["version"]}
    return result

def cargo_payload_sources(source_owners):
    """Declared flat original crate Files, separate from source-cohort archives."""
    pools = []
    for entries, completed in [(COMPLETED_SUPPLIER_ARTIFACTS, True), (NATIVE_CURRENT_ARTIFACTS or {}, False)]:
        grouped = {}
        for raw in entries.values():
            if not raw["file"]["path"].endswith(".crate"):
                continue
            row = dict(raw)
            if completed:
                row["product"] = raw["publication"]["product"]
                row["version"] = raw["publication"]["version"]
                row.pop("publication")
            target = row["file"]["path"]
            if target not in grouped:
                grouped[target] = []
            grouped[target].append(row)
        encoded = {}
        for target, rows in grouped.items():
            cargo = {(row["product"], row["version"]): True for row in rows if row["artifact"].startswith("cargo:")}
            retained = [row for row in rows if not (row["artifact"].startswith("github-release:") and (row["product"], row["version"]) in cargo)]
            retained = [row for row in retained if not any([row["artifact"] in ["cargo:" + name, "github-release:" + name + "-" + row["version"] + ".crate"] for name in source_owners])]
            if retained:
                encoded[target] = json.encode(retained)
        pools.append(encoded)
    return struct(completed = pools[0], current = pools[1])

def cargo_payload_inputs(ctx, source_owners):
    """Localize authenticated metadata Files without changing their identities."""
    pools = []
    inputs = []
    for entries in [ctx.attr.payload_completed, ctx.attr.payload_current]:
        rows = []
        for target, encoded in entries.items():
            files = target[DefaultInfo].files.to_list()
            if len(files) != 1 or files[0].is_directory or not files[0].basename.endswith(".crate"):
                fail("Cargo payload needs one original regular crate File")
            for raw in json.decode(encoded):
                row = dict(raw)
                row["file"] = dict(raw["file"], path = _runfile(ctx, files[0]))
                rows.append(row)
            inputs.append(files[0])
        pools.append(rows)
    owners = {}
    for row in PUBLICATION_CARRIERS:
        if row["ecosystem"] != "cargo" or row["name"] in source_owners:
            continue
        owner = {"product": row["product"], "version": PRODUCTS[row["product"]]["version"]}
        if row["name"] in owners and owners[row["name"]] != owner:
            fail("Cargo payload has conflicting canonical owners: " + row["name"])
        owners[row["name"]] = owner
    return struct(specification = {"completed": pools[0], "current": pools[1], "owners": owners}, files = inputs)

def _installed_cargo_test_impl(ctx):
    rust = ctx.toolchains[_RUST]
    if not rust.cargo:
        fail("installed consumer needs the declared Cargo toolchain")
    cc = cargo_test_toolchain(ctx)
    cargo_files = ctx.files.cargo_home
    archives = ctx.files.archives
    source_owners = json.decode(ctx.attr.source_identities)
    payloads = cargo_payload_inputs(ctx, source_owners)
    floor_archives = []
    floor_files = []
    for target, encoded in ctx.attr.floor_sources.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory:
            fail("completed internal floor needs one actual archive File")
        row = json.decode(encoded)
        row["file"] = _runfile(ctx, files[0])
        floor_archives.append(row)
        floor_files.append(files[0])
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode({
        "archives": [_runfile(ctx, file) for file in archives],
        "cargoHome": {_runfile(ctx, file): file.short_path.split("/registry/")[-1] for file in cargo_files},
        "manifest": _runfile(ctx, ctx.file.manifest),
        "lock": _runfile(ctx, ctx.file.lock),
        "source": _runfile(ctx, ctx.file.source),
        "coreSource": _runfile(ctx, ctx.file.core_source),
        "buildScript": _runfile(ctx, ctx.file.build_script),
        "coreBuildScript": _runfile(ctx, ctx.file.core_build_script),
        "cargo": _runfile(ctx, rust.cargo),
        "rustc": _runfile(ctx, rust.rustc),
        "rustdoc": _runfile(ctx, rust.rust_doc),
        "compiler": _runfile(ctx, cc.configuration),
        "minimum": ctx.attr.minimum,
        "selectedProducts": PREPARED_NATIVE_SELECTED_PRODUCTS,
        "sourceOwners": source_owners,
        "payloadPool": payloads.specification,
        "floorPool": {"archives": floor_archives, "owners": ctx.attr.source_owners},
    }))
    files = [specification, cc.configuration, ctx.file.manifest, ctx.file.lock, ctx.file.source, ctx.file.core_source, ctx.file.build_script, ctx.file.core_build_script, ctx.file._runner] + ctx.files._helpers + cargo_files + archives + floor_files + payloads.files + rust.all_files.to_list() + cc.files
    return bun_test_entrypoint(ctx, runner = ctx.file._runner, arguments = [specification], files = files, source_files = [ctx.file._runner] + ctx.files._helpers, runfiles_argument = True)

_installed_cargo_test = rule(
    implementation = _installed_cargo_test_impl,
    test = True,
    fragments = ["cpp"],
    toolchains = [_RUST] + BUN_SOURCE_TOOLCHAINS + use_cc_toolchain(),
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "archives": attr.label_list(mandatory = True, allow_files = True),
        "cargo_home": attr.label(mandatory = True),
        "floor_sources": attr.label_keyed_string_dict(allow_files = True),
        "source_owners": attr.string_dict(),
        "source_identities": attr.string(default = "{}"),
        "payload_completed": attr.label_keyed_string_dict(allow_files = True),
        "payload_current": attr.label_keyed_string_dict(allow_files = True),
        "manifest": attr.label(mandatory = True, allow_single_file = True),
        "lock": attr.label(mandatory = True, allow_single_file = True),
        "source": attr.label(mandatory = True, allow_single_file = True),
        "core_source": attr.label(mandatory = True, allow_single_file = True),
        "minimum": attr.bool(default = False),
        "build_script": attr.label(mandatory = True, allow_single_file = True),
        "core_build_script": attr.label(mandatory = True, allow_single_file = True),
        "_runner": attr.label(default = "//build_defs/languages/installed:consumer.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = ["//build_defs/languages:cargo-environment.mts", "//build_defs/languages:cargo-metadata.mts", "//:tools/packaging/cargo-manifest.mts", "//:tools/packaging/frozen-cargo.mts", "//:tools/packaging/portable-archive.mts"], allow_files = True),
    }),
)

def installed_cargo_test(name, args = [], **kwargs):
    _installed_cargo_test(name = name, args = bun_test_entrypoint_args(name) + args, **kwargs)

def installed_cargo_tests(name, archives, **kwargs):
    names = [CARGO[native.package_relative_label(target).package]["name"] for target in archives]
    source_owners = cargo_source_owners(names)
    owners = {name: row["product"] for name, row in source_owners.items()}
    payloads = cargo_payload_sources(source_owners)
    floors = {}
    for row in COMPLETED_SUPPLIER_ARTIFACTS.values():
        if row["artifact"] in ["cargo:" + value for value in names]:
            floors[row["file"]["path"]] = json.encode({
                "name": row["artifact"][len("cargo:"):],
                "version": row["publication"]["version"],
                "size": row["file"]["size"],
                "sha256": row["file"]["sha256"],
            })
    common = dict(kwargs, source_identities = json.encode(source_owners), payload_completed = payloads.completed, payload_current = payloads.current)
    installed_cargo_test(name = name + "_test", archives = archives, **common)
    installed_cargo_test(name = name + "_minimum_test", archives = archives, minimum = True, floor_sources = floors, source_owners = owners, **common)
