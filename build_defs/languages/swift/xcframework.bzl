"""Standard Apple XCFramework construction using the declared product profiles."""

load("@oliphaunt_toolchain_metadata//:apple-platforms.bzl", "APPLE_DEPLOYMENT_TARGETS")
load("@rules_apple//apple:apple.bzl", "apple_static_xcframework")
load("@oliphaunt_metadata//:metadata.bzl", "PRODUCTS")
load("//build_defs/apple:slices.bzl", "apple_slice_groups")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")
load("//build_defs/release:supplier.bzl", "ShippingSupplierInfo", "merge_shipping_suppliers")
load(
    "//build_defs/languages:mobile-compiled-inputs.bzl",
    _MOBILE_BINDINGS_COMPILE_OWNERS = "MOBILE_BINDINGS_COMPILE_OWNERS",
    _SwiftCompiledInputsInfo = "MobileCompiledInputsInfo",
    _compiled_inputs = "mobile_compiled_inputs",
    _mobile_bindings_compile_group = "mobile_bindings_compile_group",
    _mobile_bindings_compiled_supplier = "mobile_bindings_compiled_supplier",
)

_MACOS_PROFILE = "@apple_support//platforms:macos_arm64_platform"

BINDINGS_ENVELOPE_HELPERS = [
    Label("//build_defs/languages:mobile-legal.mts"),
    Label("//src/native/mobile-bindings:tools/dependency-license-contract.mts"),
    Label("//:tools/packaging/archive-directory.mts"),
    Label("//:tools/packaging/portable-archive.mts"),
    Label("//:tools/packaging/release-notices.mts"),
    Label("//:tools/packaging/release-directory-safety.mts"),
    Label("//:tools/packaging/rust-dependency-license-contract.mts"),
    Label("//src/native/sdks/swift:tools/swift-xcframework-contract.mts"),
]

def _package_platform_impl(settings, attr):
    # Standard Apple split transitions consult this supported label setting.
    # Preserve the SDK package's Mac deployment profile through that split.
    return {_MACOS_PROFILE: str(Label("//build_defs/host:apple_package_macos_arm64"))}

_package_platform = transition(implementation = _package_platform_impl, inputs = [], outputs = [_MACOS_PROFILE])

SWIFT_BINDINGS_COMPILE_SLOTS = ["macos-arm64", "ios-device", "ios-simulator", "host-generator"]
SWIFT_BINDINGS_COMPILE_OWNERS = _MOBILE_BINDINGS_COMPILE_OWNERS
swift_bindings_compile_group = _mobile_bindings_compile_group
swift_bindings_compiled_supplier = _mobile_bindings_compiled_supplier

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
        "_helpers": attr.label_list(default = BINDINGS_ENVELOPE_HELPERS, allow_files = True),
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
