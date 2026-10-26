"""Compile final Cargo source envelopes offline; no runtime/admission claim."""

load("@rules_cc//cc:find_cc_toolchain.bzl", "use_cc_toolchain")
load("@oliphaunt_metadata//:metadata.bzl", "COMPLETED_SUPPLIER_ARTIFACTS", "PREPARED_NATIVE_SELECTED_PRODUCTS", "PRODUCTS", "PUBLICATION_CARRIERS")
load("@wasix_tool_metadata//:targets.bzl", "WASIX_AOT_TARGETS")
load("@native_cargo_metadata//:cargo.bzl", "CARGO")
load("//build_defs/languages:source.bzl", "CargoSourceInfo")
load(":defs.bzl", "cargo_payload_inputs", "cargo_payload_sources", "cargo_source_owners")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/languages:cargo-toolchain.bzl", "cargo_test_toolchain")
load("//build_defs/release:shipping.bzl", "ShippingExportInfo", "ShippingInfo")

_RUST = "@rules_rust//rust:toolchain_type"

def _runfile(ctx, file):
    return file.short_path[3:] if file.short_path.startswith("../") else ctx.workspace_name + "/" + file.short_path

def _runtime_payload_inputs(ctx):
    if not ctx.attr.payload_export:
        return struct(rows = [], files = [])
    canonical = {row["name"]: row for row in PUBLICATION_CARRIERS if row["product"] == "liboliphaunt-wasix" and row["ecosystem"] == "cargo"}
    rows = []
    files = []
    seen = {}
    for target in ctx.attr.payload_export[ShippingExportInfo].packages:
        info = target[ShippingInfo]
        carrier = canonical.get(info.name)
        if info.configuration != "portable" and info.configuration not in WASIX_AOT_TARGETS:
            fail("current WASIX payload has no canonical configuration: " + info.configuration)
        configuration = WASIX_AOT_TARGETS.get(info.configuration, info.configuration)
        if carrier == None or info.name in seen or info.product != carrier["product"] or info.ecosystem != carrier["ecosystem"] or info.version != PRODUCTS[info.product]["version"] or info.version != carrier["version"] or info.role != carrier["role"] or configuration != carrier["target"]:
            fail("current WASIX payload differs from its canonical configured carrier: " + info.name)
        actual = info.files.to_list()
        defaults = target[DefaultInfo].files.to_list()
        if len(actual) != 1 or actual != defaults or actual[0].is_directory or actual[0].basename != info.name + "-" + info.version + ".crate":
            fail("current WASIX payload needs its one original ShippingInfo/DefaultInfo crate File")
        seen[info.name] = True
        rows.append({"product": info.product, "version": info.version, "artifact": "cargo:" + info.name, "configuration": info.configuration, "file": {"path": _runfile(ctx, actual[0])}})
        files.append(actual[0])
    if sorted(seen.keys()) != sorted(canonical.keys()):
        fail("current WASIX payload export differs from the complete canonical Cargo carrier set")
    return struct(rows = rows, files = files)

def _source_compile_tools(ctx):
    rust = ctx.toolchains[_RUST]
    if not rust.cargo:
        fail("installed source compilation needs the declared Cargo toolchain")
    cc = cargo_test_toolchain(ctx)
    return struct(
        specification = {
            "cargo": _runfile(ctx, rust.cargo),
            "rustc": _runfile(ctx, rust.rustc),
            "rustdoc": _runfile(ctx, rust.rust_doc),
            "compiler": _runfile(ctx, cc.configuration),
        },
        files = [cc.configuration] + rust.all_files.to_list() + cc.files,
    )

def _source_compile_impl(ctx):
    tools = _source_compile_tools(ctx)
    archives = [ctx.file.archive] + ctx.files.dependencies
    source_owners = json.decode(ctx.attr.source_identities)
    payloads = cargo_payload_inputs(ctx, source_owners)
    runtime_payloads = _runtime_payload_inputs(ctx)
    payload_pool = dict(payloads.specification, current = payloads.specification["current"] + runtime_payloads.rows)
    sources = {}
    source_files = []
    for target in [ctx.attr.archive] + ctx.attr.dependencies:
        source = target[CargoSourceInfo]
        sources[_runfile(ctx, source.archive)] = {"manifest": _runfile(ctx, source.manifest), "workspace": _runfile(ctx, source.workspace_manifest)}
        source_files += [source.manifest, source.workspace_manifest]
    held = []
    held_files = []
    for target, metadata in ctx.attr.held_sources.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory:
            fail("completed source dependency needs one actual archive File")
        facts = json.decode(metadata)
        facts["file"] = _runfile(ctx, files[0])
        held.append(facts)
        held_files.append(files[0])
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode(dict({
        "archives": [_runfile(ctx, file) for file in archives],
        "sources": sources,
        "minimum": ctx.attr.minimum,
        "held": held,
        "selectedProducts": PREPARED_NATIVE_SELECTED_PRODUCTS,
        "sourceOwners": source_owners,
        "payloadPool": payload_pool,
        "cargoHome": {_runfile(ctx, file): file.short_path.split("/registry/")[-1] for file in ctx.files.cargo_home},
        "lock": _runfile(ctx, ctx.file.lock),
        "index": _runfile(ctx, ctx.file.index),
        "flags": ctx.attr.cargo_args,
    }, **tools.specification)))
    files = [specification, ctx.file.lock, ctx.file.index, ctx.file._runner] + archives + source_files + held_files + payloads.files + runtime_payloads.files + ctx.files.cargo_home + ctx.files._helpers + tools.files
    return bun_test_entrypoint(ctx, runner = ctx.file._runner, arguments = [specification], files = files,
                               source_files = [ctx.file._runner] + ctx.files._helpers, runfiles_argument = True)

_source_compile_test = rule(
    implementation = _source_compile_impl,
    test = True,
    fragments = ["cpp"],
    toolchains = [_RUST] + BUN_SOURCE_TOOLCHAINS + use_cc_toolchain(),
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "archive": attr.label(mandatory = True, allow_single_file = True, providers = [CargoSourceInfo]),
        "dependencies": attr.label_list(allow_files = True, providers = [CargoSourceInfo]),
        "minimum": attr.bool(),
        "held_sources": attr.label_keyed_string_dict(allow_files = True),
        "source_identities": attr.string(default = "{}"),
        "payload_completed": attr.label_keyed_string_dict(allow_files = True),
        "payload_current": attr.label_keyed_string_dict(allow_files = True),
        "payload_export": attr.label(providers = [ShippingExportInfo]),
        "cargo_home": attr.label(mandatory = True),
        "lock": attr.label(mandatory = True, allow_single_file = True),
        "index": attr.label(mandatory = True, allow_single_file = True),
        "cargo_args": attr.string_list(),
        "_runner": attr.label(default = "//build_defs/languages/installed:source-compile.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = [
            "//build_defs/languages/installed:consumer.mts",
            "//build_defs/languages/installed:context.mts",
            "//build_defs/languages:cargo-environment.mts",
            "//build_defs/languages:cargo-metadata.mts",
            "//:tools/packaging/frozen-cargo.mts",
            "//:tools/packaging/cargo-manifest.mts",
            "//:tools/packaging/portable-archive.mts",
        ], allow_files = True),
    }),
)

def _source_compile_selection_impl(ctx):
    tools = _source_compile_tools(ctx)
    specification = ctx.actions.declare_file(ctx.label.name + ".tools.json")
    ctx.actions.write(specification, json.encode(tools.specification))
    return bun_test_entrypoint(ctx, runner = ctx.file.entry_point, arguments = [],
                               files = ctx.files.data + tools.files + [specification], source_files = [ctx.file.entry_point] + ctx.files.data,
                               environment = {"OLIPHAUNT_SOURCE_COMPILE_TEST_TOOLS": _runfile(ctx, specification)}, test_runner = True)

_source_compile_selection_test = rule(
    implementation = _source_compile_selection_impl,
    test = True,
    fragments = ["cpp"],
    toolchains = [_RUST] + BUN_SOURCE_TOOLCHAINS + use_cc_toolchain(),
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "entry_point": attr.label(mandatory = True, allow_single_file = True),
        "data": attr.label_list(allow_files = True),
    }),
)

def source_compile_selection_test(name, args = [], **kwargs):
    _source_compile_selection_test(name = name, args = bun_test_entrypoint_args(name) + args, **kwargs)

def _source_cargo_name(target):
    package = native.package_relative_label(target).package
    return CARGO[package]["name"]

def source_compile_test(name, dependencies = [], args = [], **kwargs):
    source_names = [_source_cargo_name(target) for target in [kwargs["archive"]] + dependencies]
    names = ["cargo:" + name for name in source_names[1:]]
    source_owners = cargo_source_owners(source_names)
    source_product = source_owners[source_names[0]]["product"]
    minimum = bool(dependencies) and source_product in PREPARED_NATIVE_SELECTED_PRODUCTS
    payloads = cargo_payload_sources(source_owners) if source_product in ["oliphaunt-wasix-rust", "oliphaunt-pgwire-server"] else struct(completed = {}, current = {})
    current_runtime = source_product in ["oliphaunt-wasix-rust", "oliphaunt-pgwire-server"] and "liboliphaunt-wasix" in PREPARED_NATIVE_SELECTED_PRODUCTS and any([owner["product"] in PREPARED_NATIVE_SELECTED_PRODUCTS for owner in source_owners.values()])
    held = {}
    for row in COMPLETED_SUPPLIER_ARTIFACTS.values():
        if row["artifact"] in names:
            held[row["file"]["path"]] = json.encode({
                "name": row["artifact"][len("cargo:"):],
                "version": row["publication"]["version"],
                "size": row["file"]["size"],
                "sha256": row["file"]["sha256"],
            })
    _source_compile_test(name = name, dependencies = dependencies, held_sources = held, minimum = minimum,
                         source_identities = json.encode(source_owners), payload_completed = payloads.completed, payload_current = payloads.current,
                         payload_export = "//src/wasix/runtime:cargo_shipping_export" if current_runtime else None,
                         args = bun_test_entrypoint_args(name) + args, **kwargs)
