"""Actual extension construction profiles, separate from runtime availability."""

# These profiles have extension compiler, module-layout and consumer recipes.
# A new runtime platform alone must not widen extension construction claims.
_NATIVE_PROFILES = {
    "//build_defs/native:linux_x86_64": "linux-x64-gnu",
    "//build_defs/native:linux_aarch64_gnu_2_28": "linux-arm64-gnu",
}

NATIVE_EXTENSION_CONFIGURATION = select(_NATIVE_PROFILES, no_match_error = "No extension module and installed-consumer recipe for this native platform.")
NATIVE_EXTENSION_COMPATIBLE = select({condition: [] for condition in _NATIVE_PROFILES} | {
    "//conditions:default": ["@platforms//:incompatible"],
})
