"""Node-API projections select the Rust cdylib even when import libraries coexist."""

load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts")
load("@rules_rust//rust:defs.bzl", "rust_common")
load(":rust.bzl", "napi_artifact")
load("//build_defs/wasix:napi.bzl", "WasixNapiInputsInfo", "WasixNapiReleaseInfo", "wasix_napi_release")
load("//build_defs/release:supplier.bzl", "ShippingSupplierInfo")
load("@oliphaunt_metadata//:metadata.bzl", "NATIVE_CURRENT_ARTIFACTS", "PRODUCTS", "WASIX_ARTIFACTS")

def _library_impl(ctx):
    library = ctx.actions.declare_file(ctx.label.name + ".dll")
    import_library = ctx.actions.declare_file(ctx.label.name + ".dll.lib")
    ctx.actions.write(library, "dynamic library fixture")
    ctx.actions.write(import_library, "import library fixture")
    return [
        DefaultInfo(files = depset([library, import_library])),
        rust_common.test_crate_info(crate = rust_common.crate_info(type = ctx.attr.kind, output = library)),
    ]

_library = rule(implementation = _library_impl, attrs = {"kind": attr.string()})

def _release_inputs_impl(ctx):
    tree = ctx.actions.declare_directory(ctx.label.name)
    evidence = ctx.actions.declare_file(ctx.label.name + ".evidence")
    ctx.actions.run_shell(outputs = [tree], command = "mkdir -p \"$1\"", arguments = [tree.path])
    ctx.actions.write(evidence, "analysis-only supplier fixture")
    return [
        DefaultInfo(files = depset([tree])),
        WasixNapiInputsInfo(tree = tree, target = "windows-x64-msvc", triple = "x86_64-pc-windows-msvc", sql_names = ["fixture"], sdk_version = "fixture-sdk"),
        ShippingSupplierInfo(suppliers = [{"product": "declared-supplier-fixture"}], files = depset([evidence])),
    ]

_release_inputs = rule(implementation = _release_inputs_impl)

def _projection_impl(ctx):
    env = analysistest.begin(ctx)
    actions = analysistest.target_actions(env)
    asserts.equals(env, 1, len(actions))
    asserts.equals(env, ["napi_projection_library.dll"], [file.basename for file in actions[0].inputs.to_list()])
    asserts.equals(env, ["fixture.node"], [file.basename for file in analysistest.target_under_test(env)[DefaultInfo].files.to_list()])
    release = ctx.attr.release
    asserts.equals(env, "napi_projection_library.dll", release[WasixNapiReleaseInfo].binary.basename)
    asserts.equals(env, ["napi_projection_library.dll"], [file.basename for file in release[DefaultInfo].files.to_list()])
    asserts.equals(env, "fixture-sdk", release[WasixNapiReleaseInfo].inputs.sdk_version)
    suppliers = release[ShippingSupplierInfo].suppliers
    asserts.equals(env, {"product": "declared-supplier-fixture"}, suppliers[0])
    compiled = []
    for index, product, package, group in [
        (1, "oliphaunt-wasix-rust", "src/wasix/sdks/rust", "sdk_compiled"),
        (2, "oliphaunt-pgwire-server", "src/wasix/pgwire-server", "server_compiled"),
    ]:
        supplier = suppliers[index]
        asserts.equals(env, product, supplier["product"])
        asserts.equals(env, "windows-x64-msvc", supplier["configuration"])
        asserts.equals(env, "compiled-input", supplier["binding"])
        asserts.equals(env, {"kind": "current-source"}, supplier["origin"])
        files = getattr(release[OutputGroupInfo], group).to_list()
        asserts.equals(env, 1, len(files))
        asserts.equals(env, Label("//" + package + ":shipping_supplier_fixture"), files[0].owner)
        asserts.equals(env, [{"path": files[0].path}], supplier["files"])
        compiled.extend(files)
    asserts.equals(env, sorted([file.path for file in compiled]), sorted([file.path for file in release[ShippingSupplierInfo].files.to_list() if file.basename != "napi_release_inputs.evidence"]))
    return analysistest.end(env)

_projection_test = analysistest.make(_projection_impl, attrs = {"release": attr.label(mandatory = True, providers = [WasixNapiReleaseInfo])})

def _rejected_impl(ctx):
    env = analysistest.begin(ctx)
    asserts.expect_failure(env, "Node-API artifacts require a Rust cdylib")
    return analysistest.end(env)

_rejected_test = analysistest.make(_rejected_impl, expect_failure = True)

_NapiFeaturesInfo = provider(fields = ["features", "testonly"])

def _napi_features_impl(target, ctx):
    return [_NapiFeaturesInfo(features = ctx.rule.attr.crate_features, testonly = ctx.rule.attr.testonly)]

_napi_features = aspect(implementation = _napi_features_impl, required_providers = [rust_common.crate_info])

_SdkAotPayloadInfo = provider(fields = ["files"])

def _sdk_aot_payload_impl(target, ctx):
    files = []
    if NATIVE_CURRENT_ARTIFACTS == None:
        sdk = ctx.rule.attr.sdk[0][rust_common.crate_info]
        for dependency in sdk.deps.to_list():
            crate = dependency.crate_info
            if crate and crate.name.startswith("liboliphaunt_wasix_aot_"):
                files.extend([file for file in crate.compile_data.to_list() if file.is_directory])
    return [_SdkAotPayloadInfo(files = files)]

_sdk_aot_payload = aspect(implementation = _sdk_aot_payload_impl)

def _payload_profile_impl(ctx):
    env = analysistest.begin(ctx)
    producer = analysistest.target_under_test(env)
    expected = {}
    for target in ctx.attr.public_archives:
        for file in target[DefaultInfo].files.to_list():
            if file.basename in ctx.attr.archive_names:
                asserts.false(env, file.basename in expected, "ambiguous original Cargo archive")
                expected[file.basename] = file.path
    asserts.equals(env, sorted(ctx.attr.archive_names), sorted(expected))
    actual = [file["path"] for supplier in producer[ShippingSupplierInfo].suppliers
              if supplier["product"] == "liboliphaunt-wasix" for file in supplier["files"]]
    asserts.equals(env, sorted(expected.values()), sorted(actual))
    for product, package, group in [
        ("oliphaunt-wasix-rust", "src/wasix/sdks/rust", "sdk_compiled"),
        ("oliphaunt-pgwire-server", "src/wasix/pgwire-server", "server_compiled"),
    ]:
        files = getattr(producer[OutputGroupInfo], group).to_list()
        asserts.equals(env, 1, len(files))
        asserts.equals(env, Label("//" + package + ":napi_release_lib"), files[0].owner)
        suppliers = [supplier for supplier in producer[ShippingSupplierInfo].suppliers if supplier["product"] == product]
        asserts.equals(env, 1, len(suppliers))
        asserts.equals(env, "compiled-input", suppliers[0]["binding"])
        asserts.equals(env, {"kind": "current-source"}, suppliers[0]["origin"])
        asserts.equals(env, [{"path": files[0].path}], suppliers[0]["files"])
    public_napi, unit_napi = ctx.attr.public_napi, ctx.attr.unit_napi
    public_features = public_napi[_NapiFeaturesInfo].features
    asserts.false(env, "noop" in public_features)
    asserts.equals(env, sorted(public_features + ["noop"]), sorted(unit_napi[_NapiFeaturesInfo].features))
    asserts.true(env, unit_napi[_NapiFeaturesInfo].testonly)
    asserts.equals(env, public_napi[rust_common.crate_info].root, unit_napi[rust_common.crate_info].root)
    unit_dependencies = unit_napi[rust_common.crate_info].deps.to_list()
    asserts.equals(env, 1, len(unit_dependencies))
    if len(unit_dependencies) == 1:
        asserts.equals(env, public_napi[rust_common.crate_info].deps.to_list(), unit_dependencies[0].crate_group_info.dep_variant_infos.to_list())
    if ctx.attr.public_aot_payload:
        expected_payload = ctx.attr.public_aot_payload[DefaultInfo].files.to_list()
        actual_payload = producer[_SdkAotPayloadInfo].files
        asserts.equals(env, 1, len(expected_payload))
        asserts.equals(env, expected_payload, actual_payload,
                       "SDK AOT payload paths: expected %s, got %s" % ([file.path for file in expected_payload], [file.path for file in actual_payload]))
    return analysistest.end(env)

_payload_profile_test = analysistest.make(_payload_profile_impl, attrs = {
    "public_archives": attr.label_list(allow_files = True),
    "archive_names": attr.string_list(),
    "public_napi": attr.label(default = "@cargo_crates//:napi", aspects = [_napi_features], providers = [rust_common.crate_info]),
    "unit_napi": attr.label(default = "@cargo_crates//:napi_noop", aspects = [_napi_features], providers = [rust_common.crate_info]),
    "public_aot_payload": attr.label(),
}, extra_target_under_test_aspects = [_sdk_aot_payload])

def napi_artifact_tests():
    _release_inputs(name = "napi_release_inputs", tags = ["manual"])
    _library(name = "napi_projection_library", kind = "cdylib", tags = ["manual"])
    napi_artifact(name = "napi_projection", library = ":napi_projection_library", out = "fixture.node", tags = ["manual"])
    wasix_napi_release(name = "napi_release_projection", library = ":napi_projection_library", inputs = ":napi_release_inputs", sdk = "//src/wasix/sdks/rust:shipping_supplier_fixture", server = "//src/wasix/pgwire-server:shipping_supplier_fixture", testonly = True, tags = ["manual"])
    _projection_test(name = "napi_artifact_projection_test", target_under_test = ":napi_projection", release = ":napi_release_projection")
    _library(name = "napi_rejected_library", kind = "staticlib", tags = ["manual"])
    napi_artifact(name = "napi_rejected", library = ":napi_rejected_library", out = "rejected.node", tags = ["manual"])
    _rejected_test(name = "napi_artifact_kind_test", target_under_test = ":napi_rejected")
    wasix_napi_release(name = "napi_release_rejected", library = ":napi_rejected_library", inputs = ":napi_release_inputs", sdk = "//src/wasix/sdks/rust:shipping_supplier_fixture", server = "//src/wasix/pgwire-server:shipping_supplier_fixture", testonly = True, tags = ["manual"])
    _rejected_test(name = "wasix_napi_release_kind_test", target_under_test = ":napi_release_rejected")
    archives, names, aot_payloads = {}, {}, {}
    version = PRODUCTS["liboliphaunt-wasix"]["version"]
    for row in WASIX_ARTIFACTS:
        if row["product"] != "oliphaunt-wasix-napi" or row["kind"] != "wasix-napi-addon":
            continue
        condition = "@rules_rust//rust/platform:" + row["triple"]
        packages = ["liboliphaunt-wasix-portable", "liboliphaunt-wasix-aot-" + row["triple"],
                    "oliphaunt-extension-contrib-pg18-wasix", "oliphaunt-extension-contrib-pg18-aot-" + row["target"].removesuffix("-gnu").removesuffix("-msvc")]
        archives[condition] = [
            original["file"]["path"]
            for package in packages
            for original in [NATIVE_CURRENT_ARTIFACTS.get("liboliphaunt-wasix/" + version + "/cargo:" + package)]
            if original
        ] if NATIVE_CURRENT_ARTIFACTS != None else [
            "//src/wasix/runtime/crates/assets:crate", "//src/wasix/runtime/crates/aot/" + row["triple"] + ":crate", "//build_defs/extensions/wasix:contrib",
        ]
        names[condition] = [package + "-" + version + ".crate" for package in packages]
        if NATIVE_CURRENT_ARTIFACTS == None:
            aot_payloads[condition] = "//src/wasix/runtime:aot_" + row["target"].replace("-", "_") + "_payload"
    _payload_profile_test(name = "napi_payload_profile_test", target_under_test = "//src/wasix/node-addon:release_addon",
                          public_archives = select(archives), archive_names = select(names),
                          public_aot_payload = select(aot_payloads) if NATIVE_CURRENT_ARTIFACTS == None else None)
