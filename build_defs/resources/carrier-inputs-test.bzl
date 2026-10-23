"""Check actual seed envelope inputs without constructing platform runtimes."""

load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts")
load("@oliphaunt_metadata//:metadata.bzl", "NATIVE_RUNTIME_ARTIFACTS")
load("//build_defs/release:shipping.bzl", "ShippingInfo")
load("//build_defs/release:supplier.bzl", "ShippingSupplierInfo", "merge_shipping_suppliers")
load(":mobile.bzl", "native_seed_domain")
load(":resources.bzl", "NATIVE_SEED_ABI_CONFIGURATION", "NativeSeedInfo", "WasixSeedInfo", "native_seed_abi_shipping", "native_seed_abi_suppliers", "seed_envelopes")

def _fixture_impl(ctx):
    file = ctx.actions.declare_file(ctx.label.name + ".fixture")
    ctx.actions.write(file, "analysis fixture; not a PostgreSQL seed")
    runtime = file
    if ctx.attr.separate_runtime:
        runtime = ctx.actions.declare_file(ctx.label.name + ".runtime")
        ctx.actions.write(runtime, "analysis fixture; original runtime, not its ABI receipt")
    fields = {"frozen": file, "runtime": runtime, "profile": ctx.attr.profile, "target": ctx.attr.target, "construction": file}
    seed = NativeSeedInfo(abi = file, **fields) if ctx.attr.family == "native" else WasixSeedInfo(**fields)
    suppliers = native_seed_abi_suppliers([runtime]) if ctx.attr.family == "native" else ShippingSupplierInfo(suppliers = [], files = depset())
    return [DefaultInfo(files = depset([file])), seed, suppliers, OutputGroupInfo(supplier_inputs = suppliers.files, observation_inputs = depset([file]))]

_fixture = rule(implementation = _fixture_impl, attrs = {
    "family": attr.string(default = "native"),
    "target": attr.string(default = "portable"),
    "profile": attr.string(default = "icu"),
    "separate_runtime": attr.bool(),
})

def _inputs_test_impl(ctx):
    env = analysistest.begin(ctx)
    actions = [action for action in analysistest.target_actions(env) if action.mnemonic == "ResourceCarriers"]
    asserts.equals(env, 1, len(actions))
    if actions:
        inputs = actions[0].inputs.to_list()
        asserts.equals(env, ctx.attr.needs_icu, ctx.file.icu in inputs, "the actual carrier action must declare exactly the ICU payload it reads")
    if ctx.attr.producer:
        suppliers = ctx.attr.seed[ShippingSupplierInfo]
        producer = ctx.attr.producer[ShippingInfo]
        consumer = ctx.attr.shipping[ShippingInfo]
        asserts.equals(env, suppliers.suppliers, consumer.supplier_inputs)
        asserts.equals(env, "liboliphaunt-native", producer.product)
        asserts.equals(env, "abi-contract", producer.role)
        asserts.equals(env, NATIVE_SEED_ABI_CONFIGURATION, producer.configuration)
        asserts.false(env, producer.configuration in [row["target"] for row in NATIVE_RUNTIME_ARTIFACTS], "seed provenance must not become a public runtime delivery slot")
        expected_paths = sorted([source[NativeSeedInfo].runtime.path for source in ctx.attr.supplier_sources])
        asserts.equals(env, expected_paths, sorted([file.path for file in producer.files.to_list()]))
        asserts.equals(env, expected_paths, sorted([file.path for file in suppliers.files.to_list()]))
        asserts.equals(env, 1, len(suppliers.suppliers), "the real domain must merge creator and target ABI Files into one supplier binding")
        source_suppliers = [source[ShippingSupplierInfo] for source in ctx.attr.supplier_sources]
        for sources in [source_suppliers[::-1], source_suppliers + source_suppliers]:
            asserts.equals(env, suppliers.suppliers, merge_shipping_suppliers(sources).suppliers)
        unknown = ShippingSupplierInfo(suppliers = None, files = depset([ctx.file.icu]))
        for sources in [[unknown] + source_suppliers, source_suppliers + [unknown]]:
            merged = merge_shipping_suppliers(sources)
            asserts.equals(env, None, merged.suppliers)
            asserts.equals(env, sorted(expected_paths + [ctx.file.icu.path]), sorted([file.path for file in merged.files.to_list()]))
        asserts.equals(env, [], producer.supplier_inputs)
        for supplier in suppliers.suppliers:
            asserts.equals(env, "abi-contract", supplier["binding"], "creator provenance must not imply compiled version coupling")
            asserts.equals(env, producer.product, supplier["product"])
            asserts.equals(env, producer.configuration, supplier["configuration"])
            asserts.equals(env, [{"path": path} for path in expected_paths], supplier["files"])
    return analysistest.end(env)

_inputs_test = analysistest.make(_inputs_test_impl, attrs = {
    "icu": attr.label(allow_single_file = True, mandatory = True),
    "needs_icu": attr.bool(),
    "seed": attr.label(providers = [ShippingSupplierInfo], mandatory = True),
    "shipping": attr.label(providers = [ShippingInfo], mandatory = True),
    "producer": attr.label(providers = [ShippingInfo]),
    "supplier_sources": attr.label_list(providers = [NativeSeedInfo]),
})

def seed_carrier_inputs_tests():
    fixture_kwargs = {"testonly": True, "tags": ["manual"]}
    _fixture(name = "seed_carrier_icu_fixture", **fixture_kwargs)
    for family, target, profiles in [
        ("native", "ios-datum64", ["standard", "icu"]),
        ("native", "android-datum64", ["standard", "icu"]),
        ("native", "linux-x64-gnu", ["icu"]),
        ("wasix", "portable", ["icu"]),
    ]:
        for profile in profiles:
            prefix = "seed_carrier_" + target.replace("-", "_") + "_" + profile
            if target in ["ios-datum64", "android-datum64"]:
                host = "macos-arm64" if target == "ios-datum64" else "linux-x64-gnu"
                _fixture(name = prefix + "_creator", target = host, profile = profile, **fixture_kwargs)
                receipts = []
                for abi in ["device", "simulator"] if target == "ios-datum64" else ["arm64", "x64"]:
                    name = prefix + "_" + abi + "_abi"
                    _fixture(name = name, profile = profile, separate_runtime = target == "android-datum64", **fixture_kwargs)
                    receipts.append(":" + name)
                supplier_sources = [":" + prefix + "_creator"] + receipts
                native_seed_domain(name = prefix + "_seed", producer = supplier_sources[0], receipts = receipts, suppliers = receipts,
                                   domain = target, icu = ":seed_carrier_icu_fixture" if profile == "icu" else None, **fixture_kwargs)
            else:
                _fixture(name = prefix + "_seed", family = family, target = target, profile = profile, **fixture_kwargs)
                supplier_sources = [":" + prefix + "_seed"] if family == "native" else []
            seed_envelopes(prefix, family, target, profile, ":" + prefix + "_seed", icu = ":seed_carrier_icu_fixture" if profile == "icu" else None,
                           consumer_runtime = ":seed_carrier_icu_fixture" if family == "wasix" else None, suppliers = ":" + prefix + "_seed", **fixture_kwargs)
            producer = native_seed_abi_shipping(prefix, ":" + prefix + "_seed", **fixture_kwargs) if family == "native" else None
            _inputs_test(name = prefix + "_inputs_test", target_under_test = ":" + prefix + "_carriers",
                         icu = ":seed_carrier_icu_fixture", needs_icu = profile == "icu" and target in ["ios-datum64", "android-datum64"],
                         seed = ":" + prefix + "_seed", shipping = ":" + prefix + "_github_archive", producer = producer,
                         supplier_sources = supplier_sources, size = "small")
