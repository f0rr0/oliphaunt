"""Bind Kotlin supplier coverage to its original Android and generator Rust Files."""

load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts")
load("//build_defs/languages:mobile-compiled-inputs.bzl", "MOBILE_BINDINGS_COMPILE_OWNERS", "mobile_bindings_compile_group")
load("//build_defs/release:shipping.bzl", "ShippingExportInfo", "ShippingInfo")
load("//build_defs/release:supplier.bzl", "ShippingSupplierInfo")
load(":maven.bzl", "KOTLIN_BINDINGS_COMPILE_SLOTS")

def _compiled_inputs_test_impl(ctx):
    env = analysistest.begin(ctx)
    packages = analysistest.target_under_test(env)[ShippingExportInfo].packages
    inputs = ctx.attr.maven[ShippingSupplierInfo]
    asserts.true(env, inputs.suppliers != None, "Kotlin compiler inputs require authenticated completed Query source facts")
    if inputs.suppliers == None:
        return analysistest.end(env)
    count = len(MOBILE_BINDINGS_COMPILE_OWNERS) * len(KOTLIN_BINDINGS_COMPILE_SLOTS)
    held = [row for row in inputs.suppliers if row["product"] == "oliphaunt-query"]
    asserts.equals(env, 1, len(held))
    if len(held) != 1:
        return analysistest.end(env)
    asserts.equals(env, "compiled-input", held[0]["binding"])
    asserts.equals(env, "completed-publication", held[0]["origin"]["kind"])
    asserts.equals(env, "cargo:oliphaunt-query", held[0]["origin"]["artifact"])
    asserts.equals(env, count + 1, len(inputs.suppliers))
    asserts.equals(env, count, len(packages))
    asserts.equals(env, count, len({str(package.label): True for package in packages}))
    asserts.equals(env, 4, len(ctx.attr.maven[DefaultInfo].files.to_list()))
    paths = []
    for owner, product in MOBILE_BINDINGS_COMPILE_OWNERS.items():
        producer = {"core": Label("//src/native/rust-bindings:lib"), "sdk": Label("//src/native/sdks/rust:mobile_lib"), "broker": Label("//src/native/broker:lib")}[owner]
        for slot in KOTLIN_BINDINGS_COMPILE_SLOTS:
            group = mobile_bindings_compile_group(owner, slot)
            files = getattr(ctx.attr.maven[OutputGroupInfo], group).to_list()
            asserts.equals(env, 1, len(files))
            file = files[0]
            asserts.false(env, file.is_source)
            asserts.false(env, file.is_directory)
            asserts.equals(env, producer, file.owner)
            paths.append(file.path)
            rows = [row for row in inputs.suppliers if row["product"] == product and row["configuration"] == slot]
            asserts.equals(env, 1, len(rows))
            asserts.equals(env, "compiled-input", rows[0]["binding"])
            asserts.equals(env, {"kind": "current-source"}, rows[0]["origin"])
            asserts.equals(env, [{"path": file.path}], rows[0]["files"])
            roots = [package[ShippingInfo] for package in packages if package[ShippingInfo].product == product and package[ShippingInfo].configuration == slot]
            asserts.equals(env, 1, len(roots))
            asserts.equals(env, "internal", roots[0].ecosystem)
            asserts.equals(env, product + "-kotlin-bindings", roots[0].name)
            asserts.equals(env, "compiled-source", roots[0].role)
            asserts.equals(env, rows[0]["version"], roots[0].version)
            asserts.equals(env, [file.path], [value.path for value in roots[0].files.to_list()])
            products = [MOBILE_BINDINGS_COMPILE_OWNERS["core"]] + ([MOBILE_BINDINGS_COMPILE_OWNERS["broker"]] if owner == "sdk" else [])
            expected = [] if owner == "core" else [row for row in inputs.suppliers if row["product"] in products and row["configuration"] == slot] + held
            asserts.equals(env, sorted([json.encode(row) for row in expected]), sorted([json.encode(row) for row in roots[0].supplier_inputs]))
    asserts.equals(env, count, len({file: True for file in paths}))
    plugin = ctx.attr.plugin[ShippingInfo].supplier_inputs
    asserts.equals(env, 1, len(plugin))
    asserts.equals(env, "liboliphaunt-native", plugin[0]["product"])
    asserts.equals(env, "abi-contract", plugin[0]["binding"])
    asserts.equals(env, {"kind": "current-source"}, plugin[0]["origin"])
    asserts.equals(env, ["src/native/runtime/bin/android-cxx-runtime.map", "src/native/runtime/include/oliphaunt.h"], sorted([file["path"] for file in plugin[0]["files"]]))
    asserts.equals(env, [], ctx.attr.marker[ShippingInfo].supplier_inputs)
    return analysistest.end(env)

kotlin_compiled_inputs_test = analysistest.make(_compiled_inputs_test_impl, attrs = {
    "maven": attr.label(mandatory = True, providers = [ShippingSupplierInfo, OutputGroupInfo]),
    "plugin": attr.label(mandatory = True, providers = [ShippingInfo]),
    "marker": attr.label(mandatory = True, providers = [ShippingInfo]),
})
