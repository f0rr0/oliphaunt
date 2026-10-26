"""Configure WASIX payload producers independently of their host consumers."""

load("//build_defs/release:supplier.bzl", "ShippingSupplierInfo")

def _payload_profile_impl(_settings, _attr):
    # Cargo payload construction keeps the pinned Rust defaults, outside addon link policy.
    return {"@rules_rust//rust/settings:lto": "unspecified", "@rules_rust//rust/settings:codegen_units": -1,
            "@rules_rust//rust/settings:extra_rustc_flags": []}

WASIX_PAYLOAD_PROFILE = transition(implementation = _payload_profile_impl, inputs = [], outputs = [
    "@rules_rust//rust/settings:lto", "@rules_rust//rust/settings:codegen_units", "@rules_rust//rust/settings:extra_rustc_flags",
])

def _portable_impl(_settings, _attr):
    return {"//command_line_option:platforms": [str(Label("//build_defs/wasix:portable"))]}

WASIX_PORTABLE_TRANSITION = transition(
    implementation = _portable_impl,
    inputs = [],
    outputs = ["//command_line_option:platforms"],
)

def _artifact_impl(ctx):
    artifact = ctx.attr.artifact[0]
    result = [artifact[DefaultInfo]]
    if ShippingSupplierInfo in artifact:
        result.append(artifact[ShippingSupplierInfo])
    return result

wasix_artifact = rule(
    implementation = _artifact_impl,
    attrs = {
        "artifact": attr.label(mandatory = True, cfg = WASIX_PORTABLE_TRANSITION),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    },
)
