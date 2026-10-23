"""Selected Swift consumer Files over the original source and final carriers."""

load("@oliphaunt_metadata//:metadata.bzl", "COMPLETED_SUPPLIER_ARTIFACTS", "EXTENSION_FINAL_INPUTS", "EXTENSION_RELEASE_METADATA", "NATIVE_RUNTIME_ARTIFACTS", "NATIVE_SWIFT_SOURCE_INPUT", "PREPARED_NATIVE_SELECTED_PRODUCTS", "PRODUCTS")
load("//build_defs/extensions:owner_carriers.bzl", "native_owner_carrier_helpers", "native_owner_carrier_metadata")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")
load("//build_defs/release:supplier.bzl", "ShippingSupplierInfo")

def swift_extension_fixture_helpers():
    return native_owner_carrier_helpers() + [
        "//src/native/sdks/swift:generator_sources",
        "//src/native/sdks/swift:tools/swift-extension-release-consumer-inputs.mts",
        "//src/native/sdks/swift:tools/swift-source-carrier-contract.mts",
        "//src/native/sdks/swift:tools/prepare-swift-release-consumer.mts",
    ]

def _requested_products():
    selected = PREPARED_NATIVE_SELECTED_PRODUCTS
    if "oliphaunt-swift" not in selected:
        return []
    source = NATIVE_SWIFT_SOURCE_INPUT
    if not source:
        fail("selected Swift requires its original qualified source ZIP/carrier/catalog Files")
    if source["version"] != PRODUCTS["oliphaunt-swift"]["version"]:
        fail("selected Swift original source package version differs from its conventional manifest")
    requested = []
    for product in sorted({row["artifactProduct"]: True for row in EXTENSION_RELEASE_METADATA}):
        spec = native_owner_carrier_metadata(product)
        if spec["owner"] in selected and spec["runtimeVersion"] == source["nativeVersion"]:
            requested.append(product)
    return requested

def selected_swift_extension_fixture_exports():
    return ["//build_defs/languages/swift:selected_extension_fixture_shipping_export"] if _requested_products() else []

def _impl(ctx):
    original = json.decode(ctx.attr.original)
    aliases = {}
    for target, alias in ctx.attr.original_files.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory:
            fail("Swift fixture original inputs require retained regular Files")
        aliases[alias] = files[0]
    source = {key: dict(original[key], path = aliases[original[key]["path"]].path) for key in ["archive", "carrier", "ownerCatalog"]}
    controls = []
    inputs = list(aliases.values())
    for target, product in ctx.attr.controls.items():
        files = getattr(target[OutputGroupInfo], "control_swift-extension-carrier").to_list()
        if len(files) != 1 or files[0].is_directory:
            fail("Swift fixture requires exactly one source-owned final carrier control")
        spec = native_owner_carrier_metadata(product)
        controls.append({"product": spec["owner"], "version": spec["version"], "file": {"path": files[0].path}})
        inputs.append(files[0])
    archives = json.decode(ctx.attr.assets)
    base_archives = json.decode(ctx.attr.base_archives)
    for row in archives:
        row["path"] = aliases[row["path"]].path
    for row in base_archives.values():
        row["path"] = aliases[row["path"]].path
    output = ctx.actions.declare_directory(ctx.label.name + "/release/swiftpm-extension-consumer-fixture")
    action = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(action, json.encode({"version": original["version"], "selectedProducts": PREPARED_NATIVE_SELECTED_PRODUCTS,
        "sourceArchive": source["archive"], "sourceCarrier": source["carrier"], "ownerCatalog": source["ownerCatalog"],
        "carriers": controls, "assets": archives, "baseArchives": base_archives if base_archives else None}))
    bun_file_action(ctx, ctx.file._runner, arguments = [output.path, action.path], inputs = inputs + [action],
        source_files = [ctx.file._runner] + ctx.files._helpers, outputs = [output], mnemonic = "SwiftExtensionConsumerFixture")
    suppliers = json.decode(ctx.attr.suppliers)
    for supplier in suppliers:
        for file in supplier["files"]:
            file["path"] = aliases[file["path"]].path
    return [DefaultInfo(files = depset([output])), ShippingSupplierInfo(suppliers = suppliers, files = depset(inputs))]

_fixture = rule(implementation = _impl, toolchains = BUN_SOURCE_TOOLCHAINS, attrs = {
    "original": attr.string(mandatory = True), "assets": attr.string(mandatory = True), "base_archives": attr.string(mandatory = True),
    "suppliers": attr.string(mandatory = True), "controls": attr.label_keyed_string_dict(),
    "original_files": attr.label_keyed_string_dict(allow_files = True),
    "_runner": attr.label(default = ":extension-fixture.mts", allow_single_file = True),
    "_helpers": attr.label_list(default = swift_extension_fixture_helpers(), allow_files = True),
})

def selected_swift_extension_fixture():
    requested = _requested_products()
    if not requested:
        return
    source = NATIVE_SWIFT_SOURCE_INPUT
    files = [source[key] for key in ["archive", "carrier", "ownerCatalog"]]
    assets, suppliers, controls, base_archives = [], [], {}, {}
    for product in requested:
        spec = native_owner_carrier_metadata(product)
        family = "contrib_native_family" if spec["releaseMetadata"]["class"] == "contrib" else spec["members"][0]["sqlName"] + "_family"
        controls["//build_defs/extensions:" + family] = product
        record = EXTENSION_FINAL_INPUTS.get(product + "/native/ios-xcframework")
        if not record:
            fail("selected Swift fixture is missing its original final Apple carrier File: " + product)
        assets.extend(record["github"])
        files.extend(record["github"])
        for file in record["github"]:
            suppliers.append({"product": record["owner"], "version": record["version"], "configuration": record["target"], "binding": "abi-contract",
                "origin": {"kind": "current-source", "producer": dict(file["producer"], **({"member": file["member"]} if "member" in file else {}))}, "files": [{"path": file["path"]}]})
    for key in ["archive", "carrier", "ownerCatalog"]:
        file = source[key]
        suppliers.append({"product": source["owner"], "version": source["version"], "configuration": "portable", "binding": "abi-contract",
            "origin": {"kind": "current-source", "producer": dict(file["producer"], **({"member": file["member"]} if "member" in file else {}))}, "files": [{"path": file["path"]}]})
    for role, kind, target in [("base-xcframework", "apple-swiftpm-binary", "apple-spm-xcframework"), ("runtime-resources", "runtime-resources", "ios-datum64")]:
        rows = [row for row in NATIVE_RUNTIME_ARTIFACTS if row["kind"] == kind and row["target"] == target]
        if len(rows) != 1:
            fail("Swift fixture requires one canonical native base archive role")
        artifact = "github-release:" + rows[0]["asset"].replace("{version}", source["nativeVersion"])
        capture = COMPLETED_SUPPLIER_ARTIFACTS.get("liboliphaunt-native/" + source["nativeVersion"] + "/" + artifact)
        if capture:
            base_archives[role] = capture["file"]
            files.append(capture["file"])
            suppliers.append({"product": "liboliphaunt-native", "version": source["nativeVersion"], "configuration": target, "binding": "abi-contract",
                "origin": {"kind": "completed-publication", "publication": capture["publication"], "artifact": artifact}, "files": [{"path": capture["file"]["path"]}]})
    if base_archives and len(base_archives) != 2:
        fail("selected Swift fixture original base archive tuple is incomplete")
    _fixture(name = "selected_extension_fixture", original = json.encode(source), assets = json.encode(assets),
        base_archives = json.encode(base_archives), original_files = {file["path"]: file["path"] for file in files}, controls = controls, suppliers = json.encode(suppliers))
    shipping_package(name = "selected_extension_fixture_shipping", owner = "@oliphaunt_metadata//:product_oliphaunt-swift",
        artifacts = [":selected_extension_fixture"], ecosystem = "github", package_name = "swiftpm-extension-consumer-fixture",
        configuration = "portable", role = "release-input", suppliers = ":selected_extension_fixture")
    shipping_export(name = "selected_extension_fixture_shipping_export", packages = [":selected_extension_fixture_shipping"])
