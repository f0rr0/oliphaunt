"""WASIX Cargo carriers consume declared payload construction outputs."""

load(":rust.bzl", "cargo_generator", "cargo_library", "cargo_library_test", "cargo_package_env")

def wasix_runtime_carrier(payload, portable = False):
    cargo_package_env()
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
