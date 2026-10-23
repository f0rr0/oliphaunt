"""Declared final-file imports and exhaustive native extension family composition.

Foreign-host files are inputs to these rules, never replacements for a typed C
producer. Collections are internal partial evidence. Complete family carriers
require every canonical native target and the genuine WASIX constructor for
external owners. Contrib retains separate native and WASIX runtime owners.
"""

load("@oliphaunt_metadata//:metadata.bzl", "COMPLETED_SUPPLIER_ARTIFACTS", "CONTRIB_OWNERS", "EXTENSIONS", "EXTENSION_FINAL_INPUTS", "EXTENSION_GITHUB_ARTIFACTS", "EXTENSION_PROFILES", "EXTENSION_RELEASE_METADATA", "PRODUCTS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_file_action", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/release:supplier.bzl", "ShippingSupplierInfo", "merge_shipping_suppliers")
load(":contrib_carriers.bzl", "native_contrib_carrier_legal", "native_contrib_carrier_metadata")
load(":construction.bzl", "desktop_member_inventory")
load(":final_leaf.bzl", "ExtensionFinalLeafInfo", "NativeAppleBaseInfo")
load(":native_carriers.bzl", "extension_owner_metadata", "native_extension_carrier_helpers", "native_extension_carrier_legal", "native_external_carrier_metadata")

def native_owner_carrier_helpers():
    return native_extension_carrier_helpers() + [
        "//:src/extensions/artifacts/packages/package.json",
        "//:src/extensions/artifacts/packages/Cargo.toml",
        "//build_defs/extensions:native_carriers.mts",
        "//build_defs/extensions:declared_final_inputs.mts",
        "//:src/extensions/artifacts/packages/tools/build-extension-ci-artifacts.mts",
        "//:src/extensions/artifacts/packages/tools/bundle-carrier-assets.mts",
        "//:src/extensions/artifacts/packages/tools/package-extension-cargo-facades.mts",
        "//:tools/packaging/rust-native-targets.mts",
        "//src/extensions/tools:native-component-contract.mts",
        "//:src/extensions/artifacts/native/tools/ios-extension-registration.mts",
        "//tools/release:native-file-identity.mts",
        "//tools/release:native-extension-release-files.mts",
    ]

def native_owner_carrier_metadata(product, family = "native"):
    releases = [row for row in EXTENSION_RELEASE_METADATA if row["artifactProduct"] == product]
    if not releases:
        fail("native final join requires a canonical extension distribution: " + product)
    release = releases[0]
    if family not in ["native", "wasix"] or (family == "wasix" and release["class"] != "contrib"):
        fail("separate WASIX owner composition only applies to runtime-owned contrib")
    targets = [target for profile in EXTENSION_PROFILES["profiles"] for target in profile["targets"] if target["family"] == "native"]
    target_names = sorted([target["target"] for target in targets])
    if release["class"] == "contrib":
        leaf = native_contrib_carrier_metadata(target_names[0])
        members = leaf["members"]
        owner = CONTRIB_OWNERS["native"]
        wasix_owner = CONTRIB_OWNERS["wasix"]
    else:
        if len(releases) != 1:
            fail("external native join requires one exact SQL member")
        leaf = native_external_carrier_metadata(release["sqlName"], target_names[0])
        members = [leaf]
        owner, wasix_owner = product, product
    if sorted([member["sqlName"] for member in members]) != sorted([row["sqlName"] for row in releases]):
        fail("native final join member set differs from canonical release metadata")
    dynamic = sorted([row["target"] for row in targets if row["kind"] == "native-dynamic"])
    if family == "wasix":
        owner = wasix_owner
    return {
        "schema": "oliphaunt-native-extension-final-join-inputs-v1", "product": product,
        "owner": owner, "version": PRODUCTS[owner]["version"], "runtimeVersion": leaf["runtimeVersion"],
        "releaseMetadata": release, "ownerMetadata": extension_owner_metadata(), "profiles": targets if family == "native" else [], "allProfiles": [target for profile in EXTENSION_PROFILES["profiles"] for target in profile["targets"]],
        "catalogSqlNames": sorted([row["sql-name"] for row in EXTENSIONS.values()]), "members": members, "carriers": leaf["carriers"],
        "ownerFamilies": ["wasix"] if family == "wasix" else (["native"] if owner != wasix_owner else ["native", "wasix"]),
        "cargoFacadeMetadata": {
            "nativeOwner": owner, "wasixOwner": wasix_owner, "version": leaf["version"],
            "sqlNames": sorted([member["sqlName"] for member in members]),
            "targets": {"nativeCargoTargets": dynamic, "includeWasixAot": any([member["descriptor"].get("native-module-file") for member in members])},
            "compatibility": release["compatibility"],
        },
    }

def native_owner_carrier_legal(product):
    spec = native_owner_carrier_metadata(product)
    if spec["releaseMetadata"]["class"] == "contrib":
        return native_contrib_carrier_legal()
    return native_extension_carrier_legal(spec["members"][0]["sqlName"])

def _leaf_input(leaf):
    return {"product": leaf.product, "owner": leaf.owner, "version": leaf.version, "family": leaf.family, "target": leaf.target,
            "github": [file.path for file in leaf.github], "npm": [file.path for file in leaf.npm], "cargo": [file.path for file in leaf.cargo],
            "manifest": leaf.manifest.path, "frozen": leaf.frozen.path, "validation": leaf.validation.path if leaf.validation else None,
            "receipt": leaf.receipt.path if leaf.receipt else None, "expectedOrigin": leaf.origin,
            "originalFiles": leaf.original_files.path if hasattr(leaf, "original_files") and leaf.original_files else None}

def _leaf_files(leaf):
    return leaf.github + leaf.npm + leaf.cargo + [leaf.manifest, leaf.frozen, leaf.spec] + ([leaf.validation] if leaf.validation else []) + ([leaf.receipt] if leaf.receipt else [])

# The mobile Maven action consumes the same serialized physical final leaves.
native_final_leaf_input = _leaf_input
native_final_leaf_files = _leaf_files

def _import_impl(ctx):
    spec = native_owner_carrier_metadata(ctx.attr.product)
    if ctx.attr.target not in [row["target"] for row in spec["profiles"]]:
        fail("import target is absent from canonical native extension profiles")
    if len(ctx.attr.source_commit) != 40 or len(ctx.attr.source_tree) != 40:
        fail("foreign final files require exact Git commit and tree identities")
    leaf = {"product": spec["product"], "owner": spec["owner"], "version": spec["version"], "family": "native", "target": ctx.attr.target,
            "github": [file.path for file in ctx.files.github], "npm": [file.path for file in ctx.files.npm], "cargo": [file.path for file in ctx.files.cargo],
            "manifest": ctx.file.manifest.path, "frozen": ctx.file.frozen.path, "receipt": ctx.file.receipt.path,
            "expectedOrigin": {"commit": ctx.attr.source_commit, "tree": ctx.attr.source_tree, "runId": ctx.attr.run_id, "runAttempt": ctx.attr.run_attempt, "job": ctx.attr.job}}
    spec.update({"operation": "import", "leaves": [leaf]})
    inputs = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(inputs, json.encode(spec))
    validation = ctx.actions.declare_file(ctx.label.name + ".validated.json")
    spec["outputs"] = {"collection": validation.path}
    # The action JSON is kept separate from the transported frozen documents.
    action = ctx.actions.declare_file(ctx.label.name + ".run.json")
    spec["components"] = ctx.file._components.path
    ctx.actions.write(action, json.encode(spec))
    files = ctx.files.github + ctx.files.npm + ctx.files.cargo + [ctx.file.manifest, ctx.file.frozen, ctx.file.receipt, ctx.file._components]
    bun_file_action(ctx, ctx.file._tool, arguments = [action.path], inputs = files + [action] + ctx.files.legal,
                    source_files = [ctx.file._tool] + ctx.files._helpers + ctx.files.legal, outputs = [validation], mnemonic = "ImportNativeExtensionFinalFiles")
    info = ExtensionFinalLeafInfo(product = spec["product"], owner = spec["owner"], version = spec["version"], family = "native", target = ctx.attr.target,
                                  metadata = spec, github = ctx.files.github, npm = ctx.files.npm, cargo = ctx.files.cargo,
                                  manifest = ctx.file.manifest, frozen = ctx.file.frozen, spec = inputs, validation = validation, receipt = ctx.file.receipt, origin = leaf["expectedOrigin"])
    return [DefaultInfo(files = depset(files + [validation])), info, OutputGroupInfo(validation = depset([validation]), spec = depset([inputs]))]

_TOOLS = {"_tool": attr.label(default = "//build_defs/extensions:owner_carriers.mts", allow_single_file = True),
          "_components": attr.label(default = "//src/extensions/catalog:native-components.toml", allow_single_file = True),
          "_helpers": attr.label_list(default = native_owner_carrier_helpers(), allow_files = True)}

_native_extension_final_import = rule(implementation = _import_impl, toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(_TOOLS, **{"product": attr.string(mandatory = True), "target": attr.string(mandatory = True),
        "github": attr.label_list(allow_files = True, mandatory = True), "npm": attr.label_list(allow_files = True), "cargo": attr.label_list(allow_files = True),
        "manifest": attr.label(allow_single_file = True, mandatory = True), "frozen": attr.label(allow_single_file = True, mandatory = True),
        "receipt": attr.label(allow_single_file = True, mandatory = True), "legal": attr.label_list(allow_files = True),
        "source_commit": attr.string(mandatory = True), "source_tree": attr.string(mandatory = True),
        "run_id": attr.string(mandatory = True), "run_attempt": attr.int(mandatory = True), "job": attr.string(mandatory = True)}))

def native_extension_final_import(name, product, **kwargs):
    _native_extension_final_import(name = name, product = product, legal = native_owner_carrier_legal(product), **kwargs)

def _receipt_fixture_impl(ctx):
    if not ctx.attr.testonly:
        fail("receipt fixtures are only available to testonly targets")
    leaf = ctx.attr.leaf[ExtensionFinalLeafInfo]
    output = ctx.actions.declare_file(ctx.label.name + ".json")
    inputs = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(inputs, json.encode({"qualificationFixture": {"schema": "oliphaunt-final-file-receipt-fixture-v1", "testOnly": True},
        "leaf": _leaf_input(leaf), "source": {"commit": "1" * 40, "tree": "2" * 40, "runId": "123", "runAttempt": 1, "job": "test-only-receipt-fixture"}, "output": output.path}))
    bun_file_action(ctx, ctx.file._tool, arguments = [inputs.path], inputs = _leaf_files(leaf) + [inputs] + ctx.files._helpers,
                    source_files = [ctx.file._tool] + ctx.files._helpers, outputs = [output], mnemonic = "FinalFileReceiptFixture")
    return [DefaultInfo(files = depset([output]))]

native_extension_final_receipt_fixture = rule(implementation = _receipt_fixture_impl, toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {"leaf": attr.label(mandatory = True, providers = [ExtensionFinalLeafInfo]),
             "_tool": attr.label(default = "//build_defs/extensions:final_receipt_fixture.mts", allow_single_file = True),
             "_helpers": attr.label_list(default = native_owner_carrier_helpers() + ["//build_defs/extensions:owner_carriers.mts"], allow_files = True)})

def _join_impl(ctx):
    spec = native_owner_carrier_metadata(ctx.attr.product, ctx.attr.family)
    if ctx.attr.wasix_dependency_error:
        fail(ctx.attr.wasix_dependency_error)
    dependency_manifests = []
    dependency_suppliers = []
    dependency_files = []
    for target, value in ctx.attr.wasix_dependency_manifests.items():
        record = json.decode(value)
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory:
            fail("WASIX dependency metadata requires its original regular File")
        file = files[0]
        record["file"]["path"] = file.path
        dependency_files.append(file)
        dependency_manifests.append(record)
        completed = "publication" in record
        origin = {"kind": "completed-publication", "publication": record["publication"], "artifact": record["artifact"]} if completed else {"kind": "current-source", "producer": dict(record["file"]["producer"], **({"member": record["file"]["member"]} if "member" in record["file"] else {}))}
        dependency_suppliers.append(ShippingSupplierInfo(suppliers = [{"product": record["owner"], "version": record["version"], "configuration": "wasix-portable", "binding": "abi-contract", "origin": origin, "files": [{"path": file.path}]}], files = depset([file])))
    leaves = [target[ExtensionFinalLeafInfo] for target in ctx.attr.leaves + ctx.attr.wasix_leaves]
    for leaf in leaves:
        if leaf.product != spec["product"] or leaf.owner != spec["owner"] or leaf.version != spec["version"] or leaf.family not in spec["ownerFamilies"]:
            fail("final extension files differ from their canonical distribution owner/version")
    slots = [leaf.family + "/" + leaf.target for leaf in leaves]
    targets = [leaf.target for leaf in leaves if leaf.family == "native"]
    if len(slots) != len({slot: True for slot in slots}):
        fail("final extension join contains repeated target cohorts")
    if ctx.attr.complete and sorted(targets) != sorted([row["target"] for row in spec["profiles"]]):
        fail("complete native extension family requires every canonical native target; got " + ", ".join(sorted(targets)))
    if ctx.attr.complete and "wasix" in spec["ownerFamilies"]:
        if [leaf.target for leaf in leaves if leaf.family == "wasix"] != ["wasix-portable"]:
            fail("complete extension owner requires its one genuine portable WASIX constructor")
    outputs = {"collection": ctx.actions.declare_file(ctx.label.name + ".collection.json")}
    if ctx.attr.complete:
        outputs["frozen"] = ctx.actions.declare_file(ctx.label.name + "/extension-artifacts.json")
        if "native" in spec["ownerFamilies"]:
            rows = [row for row in spec["carriers"] if row["ecosystem"] == "npm" and row["target"] == None and row["role"] == "facade"]
            if len(rows) != 1:
                fail("complete native family requires its one canonical npm facade")
            outputs["npm"] = ctx.actions.declare_file(ctx.label.name + "/npm/" + rows[0]["name"].replace("@", "").replace("/", "-") + "-" + spec["version"] + ".tgz")
            outputs["cargo"] = ctx.actions.declare_file(ctx.label.name + "/cargo/" + spec["product"] + "-" + spec["version"] + ".crate")
            if not ctx.file.base_carrier_manifest:
                fail("complete native npm facade requires the actual native base iOS carrier manifest")
        controls = [row for row in EXTENSION_GITHUB_ARTIFACTS if row["artifactProduct"] == spec["product"] and row["owner"] == spec["owner"] and row["version"] == spec["version"] and row.get("control", False)]
        if not controls or len(controls) != len({row["kind"]: True for row in controls}):
            fail("complete extension owner requires its canonical unique control inventory")
        for row in controls:
            outputs["control_" + row["kind"]] = ctx.actions.declare_file(ctx.label.name + "/github/" + row["name"])
    base = ctx.attr.base_carrier_manifest[NativeAppleBaseInfo] if ctx.attr.base_carrier_manifest and NativeAppleBaseInfo in ctx.attr.base_carrier_manifest else None
    spec.update({"operation": "compose" if ctx.attr.complete else "collect", "leaves": [_leaf_input(leaf) for leaf in leaves],
                 "baseCarrierManifest": ctx.file.base_carrier_manifest.path if ctx.file.base_carrier_manifest else None,
                 "baseArchiveInputs": base.archives if base else None,
                 "components": ctx.file._components.path, "wasixDependencyManifests": dependency_manifests,
                 "outputs": {name: file.path for name, file in outputs.items()}})
    action = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(action, json.encode(spec))
    files = [file for leaf in leaves for file in _leaf_files(leaf)] + dependency_files + [action, ctx.file._components] + ctx.files.legal + ctx.files.base_carrier_manifest + (base.archive_files if base else [])
    bun_file_action(ctx, ctx.file._tool, arguments = [action.path], inputs = files,
                    source_files = [ctx.file._tool] + ctx.files._helpers + ctx.files.legal,
                    outputs = outputs.values(), mnemonic = "NativeExtensionFamilyJoin")
    groups = {name: depset([file]) for name, file in outputs.items()}
    groups["spec"] = depset([action])
    groups["dependency_manifests"] = depset(dependency_files)
    targets = ctx.attr.leaves + ctx.attr.wasix_leaves + ([ctx.attr.base_carrier_manifest] if ctx.attr.base_carrier_manifest else [])
    suppliers = [target[ShippingSupplierInfo] for target in targets if ShippingSupplierInfo in target]
    supplier = merge_shipping_suppliers(suppliers + dependency_suppliers) if len(suppliers) == len(targets) else ShippingSupplierInfo(suppliers = None, files = depset(transitive = [info.files for info in suppliers + dependency_suppliers]))
    return [DefaultInfo(files = depset(outputs.values())), OutputGroupInfo(**groups), supplier]

_native_extension_final_join = rule(implementation = _join_impl, toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(_TOOLS, **{"product": attr.string(mandatory = True), "leaves": attr.label_list(providers = [ExtensionFinalLeafInfo], mandatory = True),
        "wasix_leaves": attr.label_list(providers = [ExtensionFinalLeafInfo]), "family": attr.string(default = "native", values = ["native", "wasix"]),
        "wasix_dependency_manifests": attr.label_keyed_string_dict(allow_files = True), "wasix_dependency_error": attr.string(),
        "complete": attr.bool(default = False), "base_carrier_manifest": attr.label(allow_single_file = True), "legal": attr.label_list(allow_files = True)}))

def native_extension_final_collection(name, product, leaves, **kwargs):
    _native_extension_final_join(name = name, product = product, leaves = leaves, legal = native_owner_carrier_legal(product), **kwargs)

def native_extension_family_carriers(name, product, leaves, base_carrier_manifest = None, wasix_leaves = [], family = "native", **kwargs):
    spec = native_owner_carrier_metadata(product, family)
    own = {member["sqlName"]: True for member in spec["members"]}
    contrib = {row["sqlName"]: True for row in EXTENSION_RELEASE_METADATA if row["class"] == "contrib"}
    needs_contrib = "native" in spec["ownerFamilies"] and "wasix" in spec["ownerFamilies"] and any([dependency in contrib and dependency not in own for member in spec["members"] for dependency in member["descriptor"].get("dependencies", [])])
    requirements, error = {}, ""
    if needs_contrib:
        required = spec["releaseMetadata"]["compatibility"]["wasixRuntimeVersion"]
        dependency_product, owner = "oliphaunt-extension-contrib-pg18", CONTRIB_OWNERS["wasix"]
        artifact = "github-release:" + dependency_product + "-" + required + "-manifest.json"
        completed = COMPLETED_SUPPLIER_ARTIFACTS.get(owner + "/" + required + "/" + artifact)
        current = EXTENSION_FINAL_INPUTS.get(dependency_product + "/wasix/wasix-portable")
        if completed:
            record = dict(completed, product = dependency_product, owner = owner, version = required, kind = "public")
        elif current and current["owner"] == owner and current["version"] == required:
            record = {"product": dependency_product, "owner": owner, "version": required, "kind": "frozen", "file": current["frozen"]}
        else:
            record = None
            error = "WASIX extension facade needs its original qualified or completed contrib manifest at " + required
        if record:
            requirements[record["file"]["path"]] = json.encode(record)
    _native_extension_final_join(name = name, product = product, leaves = leaves, complete = True,
                                 wasix_leaves = wasix_leaves, family = family,
                                 wasix_dependency_manifests = requirements, wasix_dependency_error = error,
                                 base_carrier_manifest = base_carrier_manifest, legal = native_owner_carrier_legal(product), **kwargs)

def _final_contract_test_impl(ctx):
    leaves = [target[ExtensionFinalLeafInfo] for target in ctx.attr.leaves]
    if sorted([leaf.product for leaf in leaves]) != sorted(ctx.attr.products):
        fail("final contract cohort must contain each selected canonical distribution exactly once")
    targets = {leaf.target: True for leaf in leaves}
    if len(targets) != 1:
        fail("final contract cohort must use one actual native target")
    specs = []
    for leaf in leaves:
        spec = native_owner_carrier_metadata(leaf.product)
        if leaf.owner != spec["owner"] or leaf.version != spec["version"] or leaf.family != "native":
            fail("final contract leaf differs from its canonical native owner")
        spec.update({"operation": "collect", "leaves": [_leaf_input(leaf)], "components": ctx.file._components.path, "outputs": {}})
        specs.append(spec)
    members = sorted([member["sqlName"] for spec in specs for member in spec["members"]])
    if ctx.attr.members and members != sorted(ctx.attr.members):
        fail("final contract leaves differ from the declared construction member cohort")
    inventory = ctx.actions.declare_file(ctx.label.name + ".inventory.json")
    ctx.actions.write(inventory, json.encode({"schema": "oliphaunt-native-extension-final-contract-test-v1", "scope": "construction", "target": targets.keys()[0], "products": specs, "members": members, "excluded": sorted(ctx.attr.excluded)}))
    sources = [ctx.file._runner] + ctx.files._helpers + ctx.files.legal
    files = [inventory, ctx.file._components] + [file for leaf in leaves for file in _leaf_files(leaf)] + sources
    return bun_test_entrypoint(ctx, ctx.file._runner, [inventory], files, source_files = sources) + [OutputGroupInfo(inventory = depset([inventory]))]

_native_extension_final_contract_test = rule(implementation = _final_contract_test_impl, test = True, toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "products": attr.string_list(mandatory = True), "leaves": attr.label_list(mandatory = True, providers = [ExtensionFinalLeafInfo]),
        "members": attr.string_list(), "excluded": attr.string_list(),
        "legal": attr.label_list(allow_files = True),
        "_runner": attr.label(default = "//build_defs/extensions:final_contract.test.mts", allow_single_file = True),
        "_components": _TOOLS["_components"],
        "_helpers": attr.label_list(default = native_owner_carrier_helpers() + ["//build_defs/extensions:owner_carriers.mts"], allow_files = True),
    }))

def native_extension_final_contract_test(name, products = None, desktop = False, include_postgis = False, leaves = None, **kwargs):
    """Validate genuine final packages on the execution host, without target SQL."""
    if include_postgis and not desktop:
        fail("explicit PostGIS cohort selection requires the canonical desktop inventory")
    members, excluded = [], []
    if desktop:
        if products != None:
            fail("desktop final contract uses the existing complete desktop construction inventory")
        members = [row.name for row in desktop_member_inventory(include_postgis)]
        selected = sorted({row["artifactProduct"]: True for row in EXTENSION_RELEASE_METADATA if row["sqlName"] in members}.keys())
        excluded = sorted([row["sql-name"] for row in EXTENSIONS.values() if row["sql-name"] not in members])
    else:
        selected = sorted({row["artifactProduct"]: True for row in EXTENSION_RELEASE_METADATA}.keys()) if products == None else sorted(products)
    if not selected or len(selected) != len({product: True for product in selected}):
        fail("final contract qualification requires unique canonical distributions")
    selected_leaves, legal = [], {}
    for product in selected:
        spec = native_owner_carrier_metadata(product)
        package = "src/extensions/contrib" if spec["releaseMetadata"]["class"] == "contrib" else PRODUCTS[product]["path"]
        selected_leaves.append("//" + package + ":native_carriers")
        for label in native_owner_carrier_legal(product):
            legal[label] = True
    _native_extension_final_contract_test(name = name, products = selected, members = members, excluded = excluded, leaves = selected_leaves if leaves == None else leaves, legal = legal.keys(), args = bun_test_entrypoint_args(name), **kwargs)
