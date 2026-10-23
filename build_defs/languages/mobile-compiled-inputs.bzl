"""Original configured Rust suppliers shared by the Apple and Android FFI envelopes."""

load("@oliphaunt_metadata//:metadata.bzl", "COMPLETED_SUPPLIER_PUBLICATIONS", "PRODUCTS", "PUBLICATION_CARRIERS")
load("@native_cargo_metadata//:cargo.bzl", "CARGO")
load("@rules_rust//rust:defs.bzl", "rust_common")
load("//build_defs/release:identity.bzl", "ReleaseIdentityInfo")
load("//build_defs/release:supplier.bzl", "current_rust_shipping_supplier", "held_rust_shipping_supplier", "merge_shipping_suppliers")

MOBILE_BINDINGS_COMPILE_OWNERS = {"core": "liboliphaunt-native-bindings", "sdk": "oliphaunt-rust", "broker": "oliphaunt-broker"}
MOBILE_BINDINGS_COMPILE_QUALIFICATION = {
    "core": ["//src/native/rust-bindings:unit_test"],
    "sdk": ["//src/native/sdks/rust:mobile_unit_test", "//src/native/mobile-bindings:unit_test"],
    "broker": ["//src/native/broker:unit_test"],
}
MobileCompiledInputsInfo = provider(fields = ["current", "registry", "files", "upstream"])

def mobile_bindings_compile_group(owner, configuration):
    return "compiled_" + owner + "_" + configuration.replace("-", "_")

def _compiled_slot(ctx, target):
    if target.label == Label("//src/native/mobile-bindings:lib"):
        return "host-generator"
    if ctx.target_platform_has_constraint(ctx.attr._android[platform_common.ConstraintValueInfo]):
        if ctx.target_platform_has_constraint(ctx.attr._arm64[platform_common.ConstraintValueInfo]):
            return "android-arm64-v8a"
        if ctx.target_platform_has_constraint(ctx.attr._x64[platform_common.ConstraintValueInfo]):
            return "android-x86_64"
        fail("Mobile FFI compiler source requires an actual supported Android ABI")
    if not ctx.target_platform_has_constraint(ctx.attr._arm64[platform_common.ConstraintValueInfo]):
        fail("Mobile FFI compiler source requires its actual arm64 Apple slice")
    if ctx.target_platform_has_constraint(ctx.attr._macos[platform_common.ConstraintValueInfo]):
        return "macos-arm64"
    if ctx.target_platform_has_constraint(ctx.attr._ios[platform_common.ConstraintValueInfo]):
        for name, slot in [("_device", "ios-device"), ("_simulator", "ios-simulator")]:
            if ctx.target_platform_has_constraint(getattr(ctx.attr, name)[platform_common.ConstraintValueInfo]):
                return slot
    fail("Mobile FFI compiler source has no declared Apple slice")

def _current_compiled_supplier(crate, producers, configuration):
    name, owner = producers[crate.owner]
    source = PRODUCTS[owner.id]["path"]
    if owner.id != MOBILE_BINDINGS_COMPILE_OWNERS[name] or source not in CARGO or CARGO[source]["version"] != owner.version or CARGO[source]["crate_name"] != crate.name or crate.type != "rlib":
        fail("Mobile FFI dependency differs from its actual conventional Rust owner")
    return current_rust_shipping_supplier(crate, crate.owner, owner, source, configuration)

def _compiled_upstream(ctx, crate, producers, configuration):
    current = []
    registry = []
    for dependency in crate.deps.to_list():
        value = dependency.crate_info
        if not value:
            continue
        if value.owner in producers:
            current.append(_current_compiled_supplier(value, producers, configuration))
            continue
        carriers = [row for row in PUBLICATION_CARRIERS if row["ecosystem"] == "cargo" and row["name"].replace("-", "_") == value.name]
        if not carriers:
            continue
        owner = ctx.attr._query_owner[ReleaseIdentityInfo]
        if len(carriers) != 1 or carriers[0]["product"] != owner.id:
            fail("Mobile FFI compiler contains an undeclared conventional Rust supplier: " + value.name)
        name = carriers[0]["name"]
        declaration = CARGO[crate.owner.package]["dependencies"].get(name)
        if not declaration or (type(declaration) == "dict" and "path" in declaration):
            fail("Mobile FFI query supplier must retain its actual declared registry source")
        version = declaration if type(declaration) == "string" else declaration["version"]
        key = owner.id + "@" + version.removeprefix("=")
        origin = {"kind": "completed-publication", "publication": COMPLETED_SUPPLIER_PUBLICATIONS[key], "artifact": "cargo:" + name} if key in COMPLETED_SUPPLIER_PUBLICATIONS else None
        registry.append(held_rust_shipping_supplier(value, owner, origin))
    return struct(current = merge_shipping_suppliers(current), registry = merge_shipping_suppliers(registry))

def merge_mobile_compiled_inputs(infos):
    """Keep original configured Files and their upstream coverage together."""
    files = {}
    upstream = {}
    for observed in infos:
        for group, file in observed.files.items():
            if group in files and files[group].path != file.path:
                fail("Mobile FFI compiler slot mixes original configured Files")
            files[group] = file
            upstream[group] = merge_shipping_suppliers([upstream[group], observed.upstream[group]]) if group in upstream else observed.upstream[group]
    return MobileCompiledInputsInfo(
        current = merge_shipping_suppliers([observed.current for observed in infos]),
        registry = merge_shipping_suppliers([observed.registry for observed in infos]),
        files = files,
        upstream = upstream,
    )

def _compiled_inputs_impl(target, ctx):
    infos = []
    registry = []
    files = {}
    upstream = {}
    if ctx.rule == None:
        return [MobileCompiledInputsInfo(current = merge_shipping_suppliers([]), registry = merge_shipping_suppliers([]), files = files, upstream = upstream)]
    if target.label in [Label("//src/native/mobile-bindings:static"), Label("//src/native/mobile-bindings:lib"), Label("//src/native/mobile-bindings:shared")]:
        crate = target[rust_common.test_crate_info].crate if rust_common.test_crate_info in target else target[rust_common.crate_info]
        if crate.owner != target.label or crate.type != {"static": "staticlib", "lib": "rlib", "shared": "cdylib"}[target.label.name]:
            fail("Mobile FFI inputs must belong to the actual declared mobile compiler target")
        configuration = _compiled_slot(ctx, target)
        producers = {
            Label("//src/native/rust-bindings:lib"): ("core", ctx.attr._core_owner[ReleaseIdentityInfo]),
            Label("//src/native/sdks/rust:mobile_lib"): ("sdk", ctx.attr._sdk_owner[ReleaseIdentityInfo]),
            Label("//src/native/broker:lib"): ("broker", ctx.attr._broker_owner[ReleaseIdentityInfo]),
        }
        registry.append(_compiled_upstream(ctx, crate, producers, configuration).registry)
        for value in target[rust_common.dep_info].transitive_crates.to_list():
            if value.owner not in producers:
                if value.name != "oliphaunt_query" and any([row["ecosystem"] == "cargo" and row["name"].replace("-", "_") == value.name for row in PUBLICATION_CARRIERS]):
                    fail("Mobile FFI compiler contains an undeclared conventional Rust supplier: " + value.name)
                continue
            name, _owner = producers[value.owner]
            group = mobile_bindings_compile_group(name, configuration)
            if group in files:
                fail("Mobile FFI compiler repeats an original Rust dependency")
            infos.append(_current_compiled_supplier(value, producers, configuration))
            files[group] = value.output
            dependencies = _compiled_upstream(ctx, value, producers, configuration)
            upstream[group] = merge_shipping_suppliers([dependencies.current, dependencies.registry])
            registry.append(dependencies.registry)
        if len(files) != len(producers):
            fail("Mobile FFI compiler must expose every actual local Rust dependency")
    observations = [MobileCompiledInputsInfo(current = merge_shipping_suppliers(infos), registry = merge_shipping_suppliers(registry), files = files, upstream = upstream)]
    for name in ["deps", "public_hdrs", "umbrella_header", "bindings", "library", "artifact"]:
        dependencies = getattr(ctx.rule.attr, name, [])
        if type(dependencies) != "list":
            dependencies = [dependencies]
        for dependency in dependencies:
            if dependency and MobileCompiledInputsInfo in dependency:
                observations.append(dependency[MobileCompiledInputsInfo])
    return [merge_mobile_compiled_inputs(observations)]

mobile_compiled_inputs = aspect(
    implementation = _compiled_inputs_impl,
    attr_aspects = ["deps", "public_hdrs", "umbrella_header", "bindings", "library", "artifact"],
    attrs = {
        "_core_owner": attr.label(default = Label("@oliphaunt_metadata//:product_liboliphaunt-native-bindings")),
        "_sdk_owner": attr.label(default = Label("@oliphaunt_metadata//:product_oliphaunt-rust")),
        "_broker_owner": attr.label(default = Label("@oliphaunt_metadata//:product_oliphaunt-broker")),
        "_query_owner": attr.label(default = Label("@oliphaunt_metadata//:product_oliphaunt-query")),
        "_arm64": attr.label(default = Label("@platforms//cpu:aarch64")),
        "_x64": attr.label(default = Label("@platforms//cpu:x86_64")),
        "_android": attr.label(default = Label("@platforms//os:android")),
        "_macos": attr.label(default = Label("@platforms//os:macos")),
        "_ios": attr.label(default = Label("@platforms//os:ios")),
        "_device": attr.label(default = Label("@apple_support//constraints:device")),
        "_simulator": attr.label(default = Label("@apple_support//constraints:simulator")),
    },
)

def _compiled_supplier_impl(ctx):
    compiled = ctx.attr.inputs[MobileCompiledInputsInfo]
    group = mobile_bindings_compile_group(ctx.attr.owner, ctx.attr.configuration)
    if group not in compiled.upstream:
        fail("Mobile FFI compiler root needs its exact original configured dependency coverage")
    selected = compiled.upstream[group]
    return [DefaultInfo(files = selected.files), selected]

mobile_bindings_compiled_supplier = rule(
    implementation = _compiled_supplier_impl,
    attrs = {
        "inputs": attr.label(mandatory = True, providers = [MobileCompiledInputsInfo]),
        "owner": attr.string(mandatory = True, values = MOBILE_BINDINGS_COMPILE_OWNERS.keys()),
        "configuration": attr.string(mandatory = True),
    },
)
