"""The final SwiftPM source carrier, using its declared frozen native pin."""

load("@oliphaunt_metadata//:metadata.bzl", "PRODUCTS")
load("//build_defs/apple:slices.bzl", "apple_slice_filegroup", "apple_slice_groups")
load("//build_defs/extensions:declared_final_inputs.bzl", "native_declared_apple_base")
load("//build_defs/extensions:final_leaf.bzl", "NativeAppleBaseInfo")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")
load("//build_defs/foundation:bun-sources.bzl", "bun_source_path", "bun_source_tree")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")
load("//build_defs/release:supplier.bzl", "shipping_suppliers")
load(":xcframework.bzl", "SWIFT_BINDINGS_COMPILE_OWNERS", "SWIFT_BINDINGS_COMPILE_SLOTS", "swift_bindings_compile_group", "swift_bindings_compiled_supplier")

def _swift_source_impl(ctx):
    base = ctx.attr.native_base[NativeAppleBaseInfo]
    if base.version != ctx.attr.native_version or len(base.archive_files) != 2:
        fail("Swift source must consume its exact conventional native requirement")
    archives = base.archives
    framework = [file for file in base.archive_files if file.path == archives["base-xcframework"]["path"]][0]
    resources = [file for file in base.archive_files if file.path == archives["runtime-resources"]["path"]][0]
    sources = {}
    inputs = ctx.files.sources + [ctx.file.generated_swift, ctx.file.bindings_archive, base.file, framework, resources, ctx.file.owner_catalog, ctx.file._packager] + ctx.files._helpers
    prefix = ctx.label.package + "/"
    for file in ctx.files.sources:
        member = file.short_path[len(prefix):] if file.short_path.startswith(prefix) else file.short_path
        if member in sources:
            fail("duplicate Swift source member " + member)
        sources[member] = file.path
    generators = {}
    code = bun_source_tree(ctx, ctx.label.name + ".sources", [ctx.file._packager] + ctx.files._helpers + ctx.files.generators)
    for file in ctx.files.generators:
        generators[file.basename.removesuffix(".mts") + ".mjs"] = bun_source_path(ctx, code, file)
        inputs.append(file)
    specification = ctx.actions.declare_file(ctx.label.name + ".sources.json")
    ctx.actions.write(specification, json.encode({
        "version": ctx.attr.version,
        "nativeVersion": ctx.attr.native_version,
        "sources": sources,
        "generatedSwift": ctx.file.generated_swift.path,
        "bindingsArchive": ctx.file.bindings_archive.path,
        "carrier": base.file.path,
        "xcframework": framework.path,
        "runtimeResources": resources.path,
        "generators": generators,
        "ownerCatalog": ctx.file.owner_catalog.path,
    }))
    archive = ctx.actions.declare_file(ctx.label.name + "/Oliphaunt-source.zip")
    manifest = ctx.actions.declare_file(ctx.label.name + "/Package.swift.release")
    tree = ctx.actions.declare_directory(ctx.label.name + "/release-tree")
    generator_files = [ctx.actions.declare_file(ctx.label.name + "/extension-generator/" + name) for name in ["extension-resource-inventory.mjs", "render-extension-products.mjs", "swift-carrier-resolver.mjs", "extension-owner-catalog.json"]]
    outputs = [archive, manifest, tree] + generator_files
    bun_file_action(
        ctx,
        entry_point = ctx.file._packager,
        sources = code,
        arguments = [archive.dirname, specification.path],
        inputs = depset(inputs + [specification]),
        outputs = outputs,
        mnemonic = "OliphauntSwiftSourceEnvelope",
        use_default_shell_env = False,
    )
    return [DefaultInfo(files = depset(outputs)), OutputGroupInfo(
        source_archive = depset([archive]),
        manifest = depset([manifest]),
        tree = depset([tree]),
        resource_inventory = depset([generator_files[0]]),
        extension_generator = depset([generator_files[1]]),
        carrier_resolver = depset([generator_files[2]]),
        owner_catalog = depset([generator_files[3]]),
        **apple_slice_groups([ctx.attr.bindings_archive, ctx.attr.native_base])
    )]

_swift_source = rule(
    implementation = _swift_source_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "version": attr.string(mandatory = True),
        "native_version": attr.string(mandatory = True),
        "sources": attr.label_list(allow_files = True, mandatory = True),
        "generated_swift": attr.label(allow_single_file = [".swift"], mandatory = True),
        "bindings_archive": attr.label(allow_single_file = [".zip"], mandatory = True),
        "native_base": attr.label(providers = [NativeAppleBaseInfo], mandatory = True),
        "owner_catalog": attr.label(allow_single_file = [".json"], mandatory = True),
        "generators": attr.label_list(allow_files = [".mts"], mandatory = True),
        "_packager": attr.label(default = Label("//build_defs/languages/swift:source-package.mts"), allow_single_file = True),
        "_helpers": attr.label_list(default = [
            Label("//src/native/sdks/swift:tools/swift-native-carrier-contract.mts"),
            Label("//src/native/sdks/swift:tools/swift-release-manifest.mts"),
            Label("//src/native/sdks/swift:tools/swift-source-fixture-contract.mts"),
            Label("//src/native/sdks/swift:tools/swift-xcframework-contract.mts"),
            Label("//:tools/packaging/archive-directory.mts"),
            Label("//:tools/packaging/portable-archive.mts"),
            Label("//:tools/packaging/sdk-runtime-payload.mts"),
            Label("//:tools/packaging/release-notices.mts"),
            Label("//:tools/packaging/release-directory-safety.mts"),
            Label("//:tools/packaging/emit-javascript.mts"),
        ], allow_files = True),
    },
)

def swift_source_package(name, sources, bindings_archive, bindings_release_assets, generated_swift):
    product = "oliphaunt-swift"
    descriptor = PRODUCTS[product]
    native_requirement = name + "_native_requirement"
    native_declared_apple_base(name = native_requirement, version = descriptor["compatibility_versions"]["liboliphaunt-native"], local_current = True)
    source_suppliers = name + "_suppliers"
    shipping_suppliers(name = source_suppliers, inputs = [":" + native_requirement, bindings_release_assets])
    _swift_source(
        name = name,
        version = descriptor["version"],
        native_version = descriptor["compatibility_versions"]["liboliphaunt-native"],
        sources = sources,
        generated_swift = generated_swift,
        bindings_archive = bindings_archive,
        native_base = ":" + native_requirement,
        owner_catalog = "//src/extensions/generated/sdk:extensions.json",
        generators = ["tools/extension-resource-inventory.mts", "tools/render-extension-products.mts", "tools/swift-carrier-resolver.mts"],
        target_compatible_with = ["@platforms//os:macos", "@platforms//cpu:aarch64"],
    )
    packages = []
    for group, artifact_name in [
        ("source_archive", "Oliphaunt-source.zip"),
        ("manifest", "Package.swift.release"),
        ("tree", "release-tree"),
        ("tree", "oliphaunt-react-native-ios-carriers.json"),
        ("resource_inventory", "extension-resource-inventory.mjs"),
        ("extension_generator", "render-extension-products.mjs"),
        ("carrier_resolver", "swift-carrier-resolver.mjs"),
        ("owner_catalog", "extension-owner-catalog.json"),
    ]:
        suffix = artifact_name.replace(".", "_")
        apple_slice_filegroup(name = "release_input_" + suffix, src = ":" + name, output_group = group)
        package = "shipping_" + suffix
        shipping_package(name = package, owner = "@oliphaunt_metadata//:product_" + product, artifacts = [":release_input_" + suffix], ecosystem = "github", package_name = artifact_name, configuration = "portable", role = "release-input", suppliers = ":" + source_suppliers)
        packages.append(":" + package)
    for group, suffix, artifact_name, configuration in [
        ("archive", "bindings", "oliphaunt-swift-" + descriptor["version"] + "-bindings.xcframework.zip", "apple-xcframework"),
        ("checksums", "checksums", "oliphaunt-swift-" + descriptor["version"] + "-release-assets.sha256", "portable"),
    ]:
        apple_slice_filegroup(name = "release_asset_" + suffix, src = bindings_release_assets, output_group = group)
        package = "shipping_" + suffix
        shipping_package(name = package, owner = "@oliphaunt_metadata//:product_" + product, artifacts = [":release_asset_" + suffix], ecosystem = "github", package_name = artifact_name, configuration = configuration, role = "github-release-asset", suppliers = bindings_release_assets)
        packages.append(":" + package)
    compiled_exports = []
    for owner, producer in SWIFT_BINDINGS_COMPILE_OWNERS.items():
        compiled = []
        for slot in SWIFT_BINDINGS_COMPILE_SLOTS:
            group = swift_bindings_compile_group(owner, slot)
            native.filegroup(name = name + "_" + group, srcs = [bindings_release_assets], output_group = group)
            supplier = name + "_" + owner + "_suppliers_" + slot.replace("-", "_")
            swift_bindings_compiled_supplier(name = supplier, inputs = bindings_release_assets, owner = owner, configuration = slot)
            package = "shipping_" + group
            shipping_package(name = package, owner = "@oliphaunt_metadata//:product_" + producer, artifacts = [":" + name + "_" + group],
                             ecosystem = "internal", package_name = producer + "-swift-bindings", configuration = slot, role = "compiled-source", suppliers = ":" + supplier)
            compiled.append(":" + package)
        export = name + "_" + owner + "_compiled_shipping_export"
        tests = {
            "core": ["//src/native/rust-bindings:unit_test"],
            "sdk": ["//src/native/sdks/rust:mobile_unit_test", "//src/native/mobile-bindings:unit_test"],
            "broker": ["//src/native/broker:unit_test"],
        }
        shipping_export(name = export, packages = compiled,
                        qualification = tests[owner],
                        testonly = True)
        compiled_exports.append(":" + export)
    shipping_export(name = name + "_compiled_shipping_export", exports = compiled_exports, testonly = True)
    source_checks = ["//src/native/sdks/swift:unit_test", "//src/native/sdks/swift:public_api_consumer_test", "//src/native/sdks/swift:ios_compile_test", "//src/native/sdks/swift:compiled_supplier_analysis_test"]
    shipping_export(
        name = "preparation_shipping_export",
        packages = packages,
        exports = [":" + name + "_compiled_shipping_export"],
        qualification = source_checks,
        testonly = True,
    )
    shipping_export(
        name = "shipping_export",
        packages = packages,
        exports = [":" + name + "_compiled_shipping_export"],
        qualification = source_checks + ["//src/native/sdks/swift:installed_consumer_test"],
        testonly = True,
    )
