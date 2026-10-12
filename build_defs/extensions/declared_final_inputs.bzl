"""Typed aliases of the controller's original qualified final constructor Files."""

load("@oliphaunt_metadata//:metadata.bzl", "CONTRIB_OWNERS", "EXTENSION_FINAL_INPUTS", "COMPLETED_SUPPLIER_ARTIFACTS", "NATIVE_APPLE_BASE_INPUT", "NATIVE_RUNTIME_ARTIFACTS", "NATIVE_SWIFT_SOURCE_INPUT", "PRODUCTS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")
load("//build_defs/release:supplier.bzl", "ShippingSupplierInfo")
load(":final_leaf.bzl", "ExtensionFinalLeafInfo", "NativeAppleBaseInfo")
load(":owner_carriers.bzl", "native_owner_carrier_helpers", "native_owner_carrier_metadata")

def _declared_import_impl(ctx):
    record = json.decode(ctx.attr.record)
    if not record:
        fail("extension family requires its original authenticated source/run File inputs: " + ctx.attr.slot)
    spec = native_owner_carrier_metadata(record["product"])
    owner = CONTRIB_OWNERS[record["family"]] if spec["releaseMetadata"]["class"] == "contrib" else spec["owner"]
    if record["owner"] != owner or record["version"] != PRODUCTS[owner]["version"]:
        fail("extension imported Files differ from their conventional owner/version")
    if record["family"] == "native" and record["target"] not in [row["target"] for row in spec["profiles"]]:
        fail("imported native target is absent from canonical extension profiles")
    if record["family"] == "wasix" and record["target"] != "wasix-portable":
        fail("imported WASIX family must retain its actual portable constructor cohort")
    aliases = {}
    for target, alias in ctx.attr.inputs.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory:
            fail("extension original inputs require actual regular Files")
        aliases[alias] = files[0]
    groups = {}
    for name in ["github", "npm", "cargo", "manifest", "frozen"]:
        values = record[name] if name in ["github", "npm", "cargo"] else [record[name]]
        groups[name] = [aliases[value["path"]] for value in values]
        projected = [dict(value, path = aliases[value["path"]].path) for value in values]
        record[name] = projected if name in ["github", "npm", "cargo"] else projected[0]
    action = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(action, json.encode({"input": record, "canonical": {
        "owner": owner, "version": PRODUCTS[owner]["version"],
        "sqlNames": [member["sqlName"] for member in spec["members"]],
        "sourceIdentity": spec["releaseMetadata"]["sourceIdentity"],
        "compatibility": spec["releaseMetadata"]["compatibility"],
        "extensionClass": spec["releaseMetadata"]["class"], "versioning": spec["releaseMetadata"]["versioning"],
        "targets": [row["target"] for row in spec["allProfiles"] if row["family"] == record["family"]],
    }}))
    validation = ctx.actions.declare_file(ctx.label.name + ".validated.json")
    bun_file_action(ctx, ctx.file._runner, arguments = [action.path, validation.path],
                    inputs = aliases.values() + [action], source_files = [ctx.file._runner] + ctx.files._helpers,
                    outputs = [validation], mnemonic = "ImportQualifiedExtensionFinalFiles")
    info = ExtensionFinalLeafInfo(
        product = record["product"], owner = owner, version = record["version"],
        family = record["family"], target = record["target"], metadata = spec,
        github = groups["github"], npm = groups["npm"], cargo = groups["cargo"],
        manifest = groups["manifest"][0], frozen = groups["frozen"][0], spec = action,
        validation = validation, receipt = None, origin = None, original_files = validation,
    )
    # These Files are ABI/provenance reuse, not new local compiler inputs.
    # The controller retains compiled relationships on the original host root.
    suppliers = ShippingSupplierInfo(suppliers = [{
        "product": owner, "version": record["version"], "configuration": record["target"],
        "binding": "abi-contract", "origin": {"kind": "current-source", "producer": dict(value["producer"], **({"member": value["member"]} if "member" in value else {}))},
        "files": [{"path": value["path"]}],
    } for value in record["github"]], files = depset(groups["github"]))
    return [DefaultInfo(files = depset(aliases.values() + [validation])), info, suppliers,
            OutputGroupInfo(validation = depset([validation]), spec = depset([action]))]

_declared_import = rule(implementation = _declared_import_impl, toolchains = BUN_SOURCE_TOOLCHAINS, attrs = {
    "slot": attr.string(mandatory = True), "record": attr.string(mandatory = True),
    "inputs": attr.label_keyed_string_dict(allow_files = True),
    "_runner": attr.label(default = "//build_defs/extensions:declared_final_inputs.mts", allow_single_file = True),
    "_helpers": attr.label_list(default = native_owner_carrier_helpers(), allow_files = True),
})

def native_extension_declared_final_import(name, product, family, target, **kwargs):
    slot = product + "/" + family + "/" + target
    record = EXTENSION_FINAL_INPUTS.get(slot, {})
    files = [file for group in ["github", "npm", "cargo"] for file in record.get(group, [])]
    files += [record[group] for group in ["manifest", "frozen"] if group in record]
    _declared_import(name = name, slot = slot, record = json.encode(record),
                     inputs = {file["path"]: file["path"] for file in files}, **kwargs)

def _apple_base_impl(ctx):
    record = json.decode(ctx.attr.record)
    archive_records = json.decode(ctx.attr.archive_records)
    archive_inputs = {}
    files = []
    supplier_rows = []
    for target, role in ctx.attr.archives.items():
        archive = target[DefaultInfo].files.to_list()
        if len(archive) != 1 or archive[0].is_directory:
            fail("completed Apple archive requires its exact regular File")
        captured = archive_records[role]
        archive_inputs[role] = dict(captured["file"], path = archive[0].path)
        files.append(archive[0])
        supplier_rows.append({"product": captured["publication"]["product"], "version": captured["publication"]["version"],
            "configuration": "apple-spm-xcframework" if role == "base-xcframework" else "ios-datum64", "binding": "abi-contract",
            "origin": {"kind": "completed-publication", "publication": captured["publication"], "artifact": captured["artifact"]},
            "files": [{"path": archive[0].path}]})
    if not record and len(archive_inputs) != 2:
        fail("extension native facade is missing exact completed Apple archive inputs at its declared version " + ctx.attr.version)
    if record:
        if not ctx.file.input:
            fail("original Apple base document is missing its declared File")
        record["file"]["path"] = ctx.file.input.path
        files.append(ctx.file.input)
        supplier_rows.append({"product": record["owner"], "version": record["version"],
            "configuration": "ios-xcframework" if record["owner"] == "liboliphaunt-native" else "portable",
            "binding": "abi-contract", "origin": {"kind": "current-source", "producer": dict(record["file"]["producer"], **({"member": record["file"]["member"]} if "member" in record["file"] else {}))},
            "files": [{"path": ctx.file.input.path}]})
    action = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(action, json.encode({"input": record, "archives": archive_inputs,
        "canonical": {"kind": "native-apple-base", "version": ctx.attr.version}}))
    output = ctx.actions.declare_file(ctx.label.name + "/ios.json")
    bun_file_action(ctx, ctx.file._runner, arguments = [action.path, output.path], inputs = files + [action],
                    source_files = [ctx.file._runner] + ctx.files._helpers, outputs = [output], mnemonic = "DeclaredNativeAppleBase")
    return [DefaultInfo(files = depset([output])),
            NativeAppleBaseInfo(version = ctx.attr.version, file = output, archives = archive_inputs, archive_files = [file for file in files if file != ctx.file.input]),
            ShippingSupplierInfo(suppliers = supplier_rows, files = depset(files))]

_apple_base_import = rule(implementation = _apple_base_impl, toolchains = BUN_SOURCE_TOOLCHAINS, attrs = {
    "record": attr.string(mandatory = True), "version": attr.string(mandatory = True), "input": attr.label(allow_single_file = True), "archives": attr.label_keyed_string_dict(allow_files = True), "archive_records": attr.string(mandatory = True),
    "_runner": attr.label(default = "//build_defs/extensions:declared_final_inputs.mts", allow_single_file = True),
    "_helpers": attr.label_list(default = native_owner_carrier_helpers(), allow_files = True),
})

def native_declared_apple_base(name, version = None, **kwargs):
    required = version or PRODUCTS["liboliphaunt-native"]["version"]
    if NATIVE_APPLE_BASE_INPUT and NATIVE_APPLE_BASE_INPUT["version"] == required:
        record = NATIVE_APPLE_BASE_INPUT
    elif NATIVE_SWIFT_SOURCE_INPUT and NATIVE_SWIFT_SOURCE_INPUT["nativeVersion"] == required:
        # Preserve the original Swift owner/version/member; this document is
        # never relabeled as a historical native producer.
        record = {"owner": NATIVE_SWIFT_SOURCE_INPUT["owner"], "version": NATIVE_SWIFT_SOURCE_INPUT["version"],
                  "file": NATIVE_SWIFT_SOURCE_INPUT["carrier"]}
    else:
        record = {}
    archives = {}
    for role, kind, target in [("base-xcframework", "apple-swiftpm-binary", "apple-spm-xcframework"), ("runtime-resources", "runtime-resources", "ios-datum64")]:
        rows = [row for row in NATIVE_RUNTIME_ARTIFACTS if row["product"] == "liboliphaunt-native" and row["kind"] == kind and row["target"] == target and "github-release" in row["surfaces"]]
        if len(rows) != 1:
            fail("native Apple base requires one conventional archive declaration for " + role)
        artifact = "github-release:" + rows[0]["asset"].replace("{version}", required)
        captured = COMPLETED_SUPPLIER_ARTIFACTS.get("liboliphaunt-native/" + required + "/" + artifact)
        if captured:
            archives[role] = captured
    if archives and len(archives) != 2:
        fail("native Apple base completed archive tuple is incomplete at " + required)
    _apple_base_import(name = name, record = json.encode(record), version = required,
        input = record["file"]["path"] if record else None,
        archives = {capture["file"]["path"]: role for role, capture in archives.items()},
        archive_records = json.encode(archives), **kwargs)
