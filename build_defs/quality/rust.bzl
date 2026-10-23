"""Source quality for conventional Cargo packages owned by the root package."""

load("//build_defs/languages:rust.bzl", "cargo_binary", "cargo_library_test", "cargo_package_env")
load("@rules_rust//rust:defs.bzl", "rust_clippy_test")

def root_cargo_quality():
    """Declare actual benchmark/proof compile roots without new package boundaries."""
    for name, package_name in {
        "perf": "src/benchmarks/perf/runner",
        "extension_proof": "src/extensions/tests/native",
    }.items():
        cargo_package_env(name = name + "_cargo_env", package_name = package_name)
        cargo_binary(
            name = name + "_cargo_binary",
            source = package_name + "/src/main.rs",
            package_name = package_name,
            cargo_env = ":" + name + "_cargo_env",
            path_dependencies = {"oliphaunt": "//src/native/sdks/rust:lib"},
            compile_data = ["//src/native/sdks/rust:integration_sources"] if name == "extension_proof" else [],
            tags = ["manual"],
        )
        cargo_library_test(
            name = name + "_cargo_unit_test",
            crate = ":" + name + "_cargo_binary",
            package_name = package_name,
            cargo_env = ":" + name + "_cargo_env",
            tags = ["manual"],
        )
        rust_clippy_test(
            name = name + "_clippy_test",
            targets = [":" + name + "_cargo_binary", ":" + name + "_cargo_unit_test"],
            transitive = False,
            size = "small",
        )
