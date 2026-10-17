"""Standard Apple XCFramework construction using the declared product profiles."""

load("@oliphaunt_toolchain_metadata//:apple-platforms.bzl", "APPLE_DEPLOYMENT_TARGETS")
load("@rules_apple//apple:apple.bzl", "apple_static_xcframework")
load("@oliphaunt_metadata//:metadata.bzl", "COMPLETED_SUPPLIER_PUBLICATIONS", "PRODUCTS", "PUBLICATION_CARRIERS")
load("@native_cargo_metadata//:cargo.bzl", "CARGO")
load("@rules_rust//rust:defs.bzl", "rust_common")
load("//build_defs/apple:slices.bzl", "apple_slice_groups")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")
load("//build_defs/release:identity.bzl", "ReleaseIdentityInfo")
load("//build_defs/release:supplier.bzl", "ShippingSupplierInfo", "current_rust_shipping_supplier", "held_rust_shipping_supplier", "merge_shipping_suppliers")

_MACOS_PROFILE = "@apple_support//platforms:macos_arm64_platform"

def _package_platform_impl(settings, attr):
    # Standard Apple split transitions consult this supported label setting.
    # Preserve the SDK package's Mac deployment profile through that split.
    return {_MACOS_PROFILE: str(Label("//build_defs/host:apple_package_macos_arm64"))}

_package_platform = transition(implementation = _package_platform_impl, inputs = [], outputs = [_MACOS_PROFILE])

SWIFT_BINDINGS_COMPILE_SLOTS = ["macos-arm64", "ios-device", "ios-simulator", "host-generator"]
SWIFT_BINDINGS_COMPILE_OWNERS = {"core": "liboliphaunt-native-bindings", "sdk": "oliphaunt-rust", "broker": "oliphaunt-broker"}
_SwiftCompiledInputsInfo = provider(fields = ["current", "registry", "files", "upstream"])

def swift_bindings_compile_group(owner, configuration):
    return "compiled_" + owner + "_" + configuration.replace("-", "_")

def _compiled_slot(ctx, target):
    if target.label == Label("//src/native/mobile-bindings:lib"):
        return "host-generator"
    if not ctx.target_platform_has_constraint(ctx.attr._arm64[platform_common.ConstraintValueInfo]):
        fail("Swift FFI compiler source requires its actual arm64 slice")
    if ctx.target_platform_has_constraint(ctx.attr._macos[platform_common.ConstraintValueInfo]):
        return "macos-arm64"
    if ctx.target_platform_has_constraint(ctx.attr._ios[platform_common.ConstraintValueInfo]):
        for name, slot in [("_device", "ios-device"), ("_simulator", "ios-simulator")]:
            if ctx.target_platform_has_constraint(getattr(ctx.attr, name)[platform_common.ConstraintValueInfo]):
                return slot
    fail("Swift FFI compiler source has no declared Apple slice")

def _current_compiled_supplier(crate, producers, configuration):
    name, owner = producers[crate.owner]
    source = PRODUCTS[owner.id]["path"]
    if owner.id != SWIFT_BINDINGS_COMPILE_OWNERS[name] or source not in CARGO or CARGO[source]["version"] != owner.version or CARGO[source]["crate_name"] != crate.name or crate.type != "rlib":
        fail("Swift FFI dependency differs from its actual conventional Rust owner")
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
            fail("Swift FFI compiler contains an undeclared conventional Rust supplier: " + value.name)
        name = carriers[0]["name"]
        declaration = CARGO[crate.owner.package]["dependencies"].get(name)
        if not declaration or (type(declaration) == "dict" and "path" in declaration):
            fail("Swift FFI query supplier must retain its actual declared registry source")
        version = declaration if type(declaration) == "string" else declaration["version"]
        key = owner.id + "@" + version.removeprefix("=")
        origin = {"kind": "completed-publication", "publication": COMPLETED_SUPPLIER_PUBLICATIONS[key], "artifact": "cargo:" + name} if key in COMPLETED_SUPPLIER_PUBLICATIONS else None
        registry.append(held_rust_shipping_supplier(value, owner, origin))
    return struct(current = merge_shipping_suppliers(current), registry = merge_shipping_suppliers(registry))

def _compiled_inputs_impl(target, ctx):
    infos = []
    registry = []
    files = {}
    upstream = {}
    if ctx.rule == None:
        return [_SwiftCompiledInputsInfo(current = merge_shipping_suppliers([]), registry = merge_shipping_suppliers([]), files = files, upstream = upstream)]
    if target.label in [Label("//src/native/mobile-bindings:static"), Label("//src/native/mobile-bindings:lib")]:
        crate = target[rust_common.test_crate_info].crate if rust_common.test_crate_info in target else target[rust_common.crate_info]
        if crate.owner != target.label or crate.type != ("staticlib" if target.label.name == "static" else "rlib"):
            fail("Swift FFI inputs must belong to the actual declared mobile compiler target")
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
                    fail("Swift FFI compiler contains an undeclared conventional Rust supplier: " + value.name)
                continue
            name, _owner = producers[value.owner]
            group = swift_bindings_compile_group(name, configuration)
            if group in files:
                fail("Swift FFI compiler repeats an original Rust dependency")
            infos.append(_current_compiled_supplier(value, producers, configuration))
            files[group] = value.output
            dependencies = _compiled_upstream(ctx, value, producers, configuration)
            upstream[group] = merge_shipping_suppliers([dependencies.current, dependencies.registry])
            registry.append(dependencies.registry)
        if len(files) != len(producers):
            fail("Swift FFI compiler must expose every actual local Rust dependency")
    for name in ["deps", "public_hdrs", "umbrella_header", "bindings", "library"]:
        dependencies = getattr(ctx.rule.attr, name, [])
        if type(dependencies) != "list":
            dependencies = [dependencies]
        for dependency in dependencies:
            if not dependency or _SwiftCompiledInputsInfo not in dependency:
                continue
            observed = dependency[_SwiftCompiledInputsInfo]
            infos.append(observed.current)
            registry.append(observed.registry)
            for group, file in observed.files.items():
                if group in files and files[group].path != file.path:
                    fail("Swift FFI compiler slot mixes original configured Files")
                files[group] = file
                upstream[group] = merge_shipping_suppliers([upstream[group], observed.upstream[group]]) if group in upstream else observed.upstream[group]
    return [_SwiftCompiledInputsInfo(current = merge_shipping_suppliers(infos), registry = merge_shipping_suppliers(registry), files = files, upstream = upstream)]

_compiled_inputs = aspect(
    implementation = _compiled_inputs_impl,
    attr_aspects = ["deps", "public_hdrs", "umbrella_header", "bindings", "library"],
    attrs = {
        "_core_owner": attr.label(default = Label("@oliphaunt_metadata//:product_liboliphaunt-native-bindings")),
        "_sdk_owner": attr.label(default = Label("@oliphaunt_metadata//:product_oliphaunt-rust")),
        "_broker_owner": attr.label(default = Label("@oliphaunt_metadata//:product_oliphaunt-broker")),
        "_query_owner": attr.label(default = Label("@oliphaunt_metadata//:product_oliphaunt-query")),
        "_arm64": attr.label(default = Label("@platforms//cpu:aarch64")),
        "_macos": attr.label(default = Label("@platforms//os:macos")),
        "_ios": attr.label(default = Label("@platforms//os:ios")),
        "_device": attr.label(default = Label("@apple_support//constraints:device")),
        "_simulator": attr.label(default = Label("@apple_support//constraints:simulator")),
    },
)

def _archive_impl(ctx):
    archive = ctx.attr.archive[0]
    compiled = archive[_SwiftCompiledInputsInfo]
    expected = [swift_bindings_compile_group(owner, slot) for owner in SWIFT_BINDINGS_COMPILE_OWNERS for slot in SWIFT_BINDINGS_COMPILE_SLOTS]
    if sorted(compiled.files) != sorted(expected) or sorted(compiled.upstream) != sorted(expected):
        fail("Swift XCFramework must retain its complete original Rust compiler File inventory")
    return [archive[DefaultInfo], compiled, merge_shipping_suppliers([compiled.current, compiled.registry]), OutputGroupInfo(**(apple_slice_groups([archive]) | {name: depset([file]) for name, file in compiled.files.items()}))]

_product_archive = rule(
    implementation = _archive_impl,
    attrs = {
        "archive": attr.label(mandatory = True, cfg = _package_platform, aspects = [_compiled_inputs]),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    },
)

def bindings_xcframework(name, library, header):
    """Build the canonical three Rust FFI slices; legal envelope is separate."""
    apple_static_xcframework(
        name = name + "_archive",
        bundle_name = "OliphauntNativeBindingsFFI",
        deps = [library],
        public_hdrs = [header],
        umbrella_header = header,
        ios = {"device": ["arm64"], "simulator": ["arm64"]},
        macos = ["arm64"],
        minimum_os_versions = {"macos": APPLE_DEPLOYMENT_TARGETS["package_macos"], "ios": APPLE_DEPLOYMENT_TARGETS["ios"]},
        tags = ["no-remote"],
        target_compatible_with = ["@platforms//os:macos", "@platforms//cpu:aarch64"],
        visibility = ["//visibility:private"],
    )
    _product_archive(name = name, archive = ":" + name + "_archive", target_compatible_with = ["@platforms//os:macos", "@platforms//cpu:aarch64"])

def _bindings_envelope_impl(ctx):
    files = ctx.files.sources
    source_paths = {}
    for file in files:
        if file.short_path in source_paths:
            fail("duplicate FFI legal source: " + file.short_path)
        source_paths[file.short_path] = file.path
    specification = ctx.actions.declare_file(ctx.label.name + ".sources.json")
    ctx.actions.write(specification, json.encode(source_paths))
    archive = ctx.actions.declare_file(ctx.attr.archive_name)
    checksums = ctx.actions.declare_file(ctx.attr.checksum_name)
    bun_file_action(
        ctx,
        entry_point = ctx.file._packager,
        source_files = [ctx.file._packager] + ctx.files._helpers,
        arguments = [ctx.file.intermediate.path, archive.path, specification.path, checksums.path],
        inputs = depset([ctx.file.intermediate, ctx.file._packager, specification] + files + ctx.files._helpers),
        outputs = [archive, checksums],
        mnemonic = "OliphauntSwiftBindingsEnvelope",
        use_default_shell_env = False,
    )
    groups = apple_slice_groups([ctx.attr.intermediate]) | {"archive": depset([archive]), "checksums": depset([checksums])}
    for owner in SWIFT_BINDINGS_COMPILE_OWNERS:
        for slot in SWIFT_BINDINGS_COMPILE_SLOTS:
            group = swift_bindings_compile_group(owner, slot)
            groups[group] = getattr(ctx.attr.intermediate[OutputGroupInfo], group)
    return [DefaultInfo(files = depset([archive, checksums])), OutputGroupInfo(**groups), ctx.attr.intermediate[ShippingSupplierInfo], ctx.attr.intermediate[_SwiftCompiledInputsInfo]]

_bindings_envelope = rule(
    implementation = _bindings_envelope_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "intermediate": attr.label(mandatory = True, allow_single_file = [".zip"], providers = [ShippingSupplierInfo, OutputGroupInfo, _SwiftCompiledInputsInfo]),
        "sources": attr.label_list(allow_files = True, mandatory = True),
        "archive_name": attr.string(mandatory = True),
        "checksum_name": attr.string(mandatory = True),
        "_packager": attr.label(default = Label("//build_defs/languages/swift:xcframework-envelope.mts"), allow_single_file = True),
        "_helpers": attr.label_list(default = [Label("//build_defs/languages:mobile-legal.mts"), Label("//:tools/packaging/archive-directory.mts"), Label("//:tools/packaging/portable-archive.mts"), Label("//:tools/packaging/release-notices.mts"), Label("//:tools/packaging/release-directory-safety.mts"), Label("//:tools/packaging/rust-dependency-license-contract.mts"), Label("//src/native/sdks/swift:tools/swift-xcframework-contract.mts")], allow_files = True),
    },
)

def _compiled_supplier_impl(ctx):
    compiled = ctx.attr.inputs[_SwiftCompiledInputsInfo]
    group = swift_bindings_compile_group(ctx.attr.owner, ctx.attr.configuration)
    if group not in compiled.upstream:
        fail("Swift compiler root needs its exact original configured dependency coverage")
    selected = compiled.upstream[group]
    return [DefaultInfo(files = selected.files), selected]

swift_bindings_compiled_supplier = rule(
    implementation = _compiled_supplier_impl,
    attrs = {
        "inputs": attr.label(mandatory = True, providers = [_SwiftCompiledInputsInfo]),
        "owner": attr.string(mandatory = True, values = SWIFT_BINDINGS_COMPILE_OWNERS.keys()),
        "configuration": attr.string(mandatory = True),
    },
)

def bindings_envelope(name, intermediate):
    version = PRODUCTS["oliphaunt-swift"]["version"]
    _bindings_envelope(
        name = name,
        intermediate = intermediate,
        sources = ["//src/native/mobile-bindings:license_inputs", "//:Cargo.lock", "//:LICENSE", "//:THIRD_PARTY_NOTICES.md"],
        archive_name = "oliphaunt-swift-" + version + "-bindings.xcframework.zip",
        checksum_name = "oliphaunt-swift-" + version + "-release-assets.sha256",
        target_compatible_with = ["@platforms//os:macos", "@platforms//cpu:aarch64"],
    )
