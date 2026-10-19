"""WASIX Cargo carriers consume declared payload construction outputs."""

load(":rust.bzl", "cargo_generator", "cargo_library", "cargo_library_test", "cargo_package_env")
load("@rules_rust//rust:defs.bzl", "rust_clippy_test")
load("//build_defs/wasix:platform.bzl", "WASIX_PAYLOAD_PROFILE")

def _cargo_payload_impl(ctx):
    return [ctx.attr.payload[0][DefaultInfo]]

_cargo_payload = rule(
    implementation = _cargo_payload_impl,
    attrs = {
        "payload": attr.label(mandatory = True, cfg = WASIX_PAYLOAD_PROFILE),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    },
)

def wasix_runtime_carrier(payload, portable = False):
    cargo_package_env()
    _cargo_payload(name = "cargo_payload", payload = payload)
    payload = ":cargo_payload"
    environment = {
        "OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD": "1",
        # Native packaging consumes declared File providers. Conventional
        # Cargo's mutable target-directory descriptor is not a native output.
        "OLIPHAUNT_ARTIFACT_CRATE_EMIT_CARGO_MANIFEST": "0",
        "OLIPHAUNT_WASIX_GENERATED_ASSETS_DIR" if portable else "OLIPHAUNT_WASM_GENERATED_AOT_DIR": "$(execpath " + payload + ")",
    }
    cargo_generator(srcs = ["build-support.rs"], data = [payload], build_script_env = environment)
    cargo_library(build_script = ":build_script", compile_data = [payload])
    cargo_library_test()

    # Cargo permits absent payloads for source checks; shipping remains strict.
    cargo_generator(name = "quality_build_script", srcs = ["build-support.rs"])
    cargo_library(name = "quality_lib", build_script = ":quality_build_script")
    cargo_library_test(name = "quality_unit_test", crate = ":quality_lib")
    rust_clippy_test(
        name = "clippy_test",
        targets = [":quality_lib", ":quality_unit_test", ":quality_build_script_"],
        transitive = False,
        size = "small",
    )
