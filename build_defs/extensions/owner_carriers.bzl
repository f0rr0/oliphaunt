"""Declared final-file imports and exhaustive native extension family composition.

Foreign-host files are inputs to these rules, never replacements for a typed C
producer. Collections are internal partial evidence. Complete family carriers
require every canonical native target; external owner-wide WASIX joins remain
separate from this native family surface.
"""

load("@oliphaunt_metadata//:metadata.bzl", "CONTRIB_OWNERS", "EXTENSIONS", "EXTENSION_PROFILES", "EXTENSION_RELEASE_METADATA", "PRODUCTS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_file_action", "bun_test_entrypoint", "bun_test_entrypoint_args")
load(":contrib_carriers.bzl", "native_contrib_carrier_legal", "native_contrib_carrier_metadata")
load(":final_leaf.bzl", "ExtensionFinalLeafInfo")
load(":native_carriers.bzl", "native_extension_carrier_helpers", "native_extension_carrier_legal", "native_external_carrier_metadata")

def native_owner_carrier_helpers():
    return native_extension_carrier_helpers() + [
        "//build_defs/extensions:native_carriers.mts",
        "//:src/extensions/artifacts/packages/tools/build-extension-ci-artifacts.mts",
        "//:src/extensions/artifacts/packages/tools/bundle-carrier-assets.mts",
        "//:src/extensions/artifacts/packages/tools/package-extension-cargo-facades.mts",
        "//:tools/packaging/rust-native-targets.mts",
        "//src/extensions/tools:native-component-contract.mts",
    ]

def native_owner_carrier_metadata(product):
    releases = [row for row in EXTENSION_RELEASE_METADATA if row["artifactProduct"] == product]
    if not releases:
        fail("native final join requires a canonical extension distribution: " + product)
    release = releases[0]
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
    return {
        "schema": "oliphaunt-native-extension-final-join-inputs-v1", "product": product,
        "owner": owner, "version": leaf["version"], "runtimeVersion": leaf["runtimeVersion"],
        "releaseMetadata": release, "profiles": targets, "allProfiles": [target for profile in EXTENSION_PROFILES["profiles"] for target in profile["targets"]],
        "catalogSqlNames": sorted([row["sql-name"] for row in EXTENSIONS.values()]), "members": members, "carriers": leaf["carriers"],
        "ownerFamilies": ["native"] if owner != wasix_owner else ["native", "wasix"],
        "cargoFacadeMetadata": {
            "nativeOwner": owner, "wasixOwner": wasix_owner, "version": leaf["version"],
            "sqlNames": sorted([member["sqlName"] for member in members]),
            "targets": {"nativeCargoTargets": dynamic, "includeWasixAot": any([member["descriptor"].get("native-module-file") for member in members])},
            "sdkVersion": PRODUCTS["oliphaunt-rust"]["version"], "bindingVersion": PRODUCTS["liboliphaunt-native-bindings"]["version"],
            "wasixSdkVersion": PRODUCTS["oliphaunt-wasix-rust"]["version"], "compatibility": release["compatibility"],
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
            "receipt": leaf.receipt.path if leaf.receipt else None, "expectedOrigin": leaf.origin}

def _leaf_files(leaf):
    return leaf.github + leaf.npm + leaf.cargo + [leaf.manifest, leaf.frozen, leaf.spec] + ([leaf.validation] if leaf.validation else []) + ([leaf.receipt] if leaf.receipt else [])

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
    spec = native_owner_carrier_metadata(ctx.attr.product)
    leaves = [target[ExtensionFinalLeafInfo] for target in ctx.attr.leaves]
    for leaf in leaves:
        if leaf.product != spec["product"] or leaf.owner != spec["owner"] or leaf.version != spec["version"] or leaf.family != "native":
            fail("final extension files differ from their canonical distribution owner/version")
    targets = [leaf.target for leaf in leaves]
    if len(targets) != len({target: True for target in targets}):
        fail("final extension join contains repeated target cohorts")
    if ctx.attr.complete and sorted(targets) != sorted([row["target"] for row in spec["profiles"]]):
        fail("complete native extension family requires every canonical native target; got " + ", ".join(sorted(targets)))
    outputs = {"collection": ctx.actions.declare_file(ctx.label.name + ".collection.json")}
    if ctx.attr.complete:
        outputs["github"] = ctx.actions.declare_directory(ctx.label.name + "/native-family-release")
        outputs["npm"] = ctx.actions.declare_directory(ctx.label.name + "/npm-facade")
        if spec["ownerFamilies"] == ["native"]:
            outputs["cargo"] = ctx.actions.declare_directory(ctx.label.name + "/cargo-facade")
        if not ctx.file.base_carrier_manifest:
            fail("complete native npm facade requires the actual native base iOS carrier manifest")
    spec.update({"operation": "compose" if ctx.attr.complete else "collect", "leaves": [_leaf_input(leaf) for leaf in leaves],
                 "baseCarrierManifest": ctx.file.base_carrier_manifest.path if ctx.file.base_carrier_manifest else None,
                 "components": ctx.file._components.path,
                 "outputs": {name: file.path for name, file in outputs.items()}})
    action = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(action, json.encode(spec))
    files = [file for leaf in leaves for file in _leaf_files(leaf)] + [action, ctx.file._components] + ctx.files.legal + ctx.files.base_carrier_manifest
    bun_file_action(ctx, ctx.file._tool, arguments = [action.path], inputs = files,
                    source_files = [ctx.file._tool] + ctx.files._helpers + ctx.files.legal,
                    outputs = outputs.values(), mnemonic = "NativeExtensionFamilyJoin")
    groups = {name: depset([file]) for name, file in outputs.items()}
    groups["spec"] = depset([action])
    return [DefaultInfo(files = depset(outputs.values())), OutputGroupInfo(**groups)]

_native_extension_final_join = rule(implementation = _join_impl, toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(_TOOLS, **{"product": attr.string(mandatory = True), "leaves": attr.label_list(providers = [ExtensionFinalLeafInfo], mandatory = True),
        "complete": attr.bool(default = False), "base_carrier_manifest": attr.label(allow_single_file = True), "legal": attr.label_list(allow_files = True)}))

def native_extension_final_collection(name, product, leaves, **kwargs):
    _native_extension_final_join(name = name, product = product, leaves = leaves, legal = native_owner_carrier_legal(product), **kwargs)

def native_extension_family_carriers(name, product, leaves, base_carrier_manifest, **kwargs):
    _native_extension_final_join(name = name, product = product, leaves = leaves, complete = True,
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
    inventory = ctx.actions.declare_file(ctx.label.name + ".inventory.json")
    ctx.actions.write(inventory, json.encode({"schema": "oliphaunt-native-extension-final-contract-test-v1", "scope": "construction", "target": targets.keys()[0], "products": specs}))
    sources = [ctx.file._runner] + ctx.files._helpers + ctx.files.legal
    files = [inventory, ctx.file._components] + [file for leaf in leaves for file in _leaf_files(leaf)] + sources
    return bun_test_entrypoint(ctx, ctx.file._runner, [inventory], files, source_files = sources) + [OutputGroupInfo(inventory = depset([inventory]))]

_native_extension_final_contract_test = rule(implementation = _final_contract_test_impl, test = True, toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "products": attr.string_list(mandatory = True), "leaves": attr.label_list(mandatory = True, providers = [ExtensionFinalLeafInfo]),
        "legal": attr.label_list(allow_files = True),
        "_runner": attr.label(default = "//build_defs/extensions:final_contract.test.mts", allow_single_file = True),
        "_components": _TOOLS["_components"],
        "_helpers": attr.label_list(default = native_owner_carrier_helpers() + ["//build_defs/extensions:owner_carriers.mts"], allow_files = True),
    }))

def native_extension_final_contract_test(name, products = None, **kwargs):
    """Validate genuine final packages on the execution host, without target SQL."""
    selected = sorted({row["artifactProduct"]: True for row in EXTENSION_RELEASE_METADATA}.keys()) if products == None else sorted(products)
    if not selected or len(selected) != len({product: True for product in selected}):
        fail("final contract qualification requires unique canonical distributions")
    leaves, legal = [], {}
    for product in selected:
        spec = native_owner_carrier_metadata(product)
        package = "src/extensions/contrib" if spec["releaseMetadata"]["class"] == "contrib" else PRODUCTS[product]["path"]
        leaves.append("//" + package + ":native_carriers")
        for label in native_owner_carrier_legal(product):
            legal[label] = True
    _native_extension_final_contract_test(name = name, products = selected, leaves = leaves, legal = legal.keys(), args = bun_test_entrypoint_args(name), **kwargs)
