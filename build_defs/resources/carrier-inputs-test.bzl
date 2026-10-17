"""Check actual seed envelope inputs without constructing platform runtimes."""

load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts")
load(":resources.bzl", "NativeSeedInfo", "WasixSeedInfo", "seed_envelopes")

def _fixture_impl(ctx):
    file = ctx.actions.declare_file(ctx.label.name + ".fixture")
    ctx.actions.write(file, "analysis fixture; not a PostgreSQL seed")
    fields = {"frozen": file, "runtime": file, "profile": ctx.attr.profile, "target": ctx.attr.target, "construction": file}
    seed = NativeSeedInfo(abi = file, **fields) if ctx.attr.family == "native" else WasixSeedInfo(**fields)
    return [DefaultInfo(files = depset([file])), seed]

_fixture = rule(implementation = _fixture_impl, attrs = {
    "family": attr.string(default = "native"),
    "target": attr.string(default = "portable"),
    "profile": attr.string(default = "icu"),
})

def _inputs_test_impl(ctx):
    env = analysistest.begin(ctx)
    actions = [action for action in analysistest.target_actions(env) if action.mnemonic == "ResourceCarriers"]
    asserts.equals(env, 1, len(actions))
    if actions:
        inputs = actions[0].inputs.to_list()
        asserts.equals(env, ctx.attr.needs_icu, ctx.file.icu in inputs, "the actual carrier action must declare exactly the ICU payload it reads")
    return analysistest.end(env)

_inputs_test = analysistest.make(_inputs_test_impl, attrs = {
    "icu": attr.label(allow_single_file = True, mandatory = True),
    "needs_icu": attr.bool(),
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
            _fixture(name = prefix + "_seed", family = family, target = target, profile = profile, **fixture_kwargs)
            seed_envelopes(prefix, family, target, profile, ":" + prefix + "_seed", icu = ":seed_carrier_icu_fixture" if profile == "icu" else None,
                           consumer_runtime = ":seed_carrier_icu_fixture" if family == "wasix" else None, **fixture_kwargs)
            _inputs_test(name = prefix + "_inputs_test", target_under_test = ":" + prefix + "_carriers",
                         icu = ":seed_carrier_icu_fixture", needs_icu = profile == "icu" and target in ["ios-datum64", "android-datum64"], size = "small")
