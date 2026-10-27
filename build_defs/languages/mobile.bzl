"""Host UniFFI generator from the conventional mobile bindgen target."""

load("@mobile_bindgen_crates//:defs.bzl", "crate_deps")
load("@native_cargo_metadata//:cargo.bzl", "CARGO")
load("@rules_rust//rust:defs.bzl", "rust_binary")
load(":rust.bzl", "cargo_features")

def mobile_bindgen(name = "bindgen"):
    facts = CARGO[native.package_name()]
    binaries = [target for target in facts["binaries"] if target.get("required-features") == ["bindgen"]]
    if len(binaries) != 1 or facts["features"].get("bindgen") != ["uniffi/cli"]:
        fail("Mobile generator must retain its conventional UniFFI CLI target contract")
    target = binaries[0]
    # This target's source calls only UniFFI's CLI. The mobile runtime library
    # is the generator's data input, not an executable dependency of its CLI.
    rust_binary(
        name = name,
        srcs = [target["path"]],
        crate_root = target["path"],
        crate_name = target["name"].replace("-", "_"),
        crate_features = cargo_features(facts, ["bindgen"], False),
        edition = facts["edition"],
        version = facts["version"],
        rustc_env_files = [":cargo_env"],
        deps = crate_deps(["uniffi"], package_name = native.package_name()),
    )
