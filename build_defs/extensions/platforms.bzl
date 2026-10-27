"""Actual extension construction profiles, separate from runtime availability."""

# Construction support is distinct from the installed Linux lifecycle recipe.
# PostGIS's dependency configuration and mobile's static registry are separate
# recipes; neither inherits support from a desktop runtime target.
_LINUX_PROFILES = {
    "//build_defs/native:linux_x86_64": "linux-x64-gnu",
    "//build_defs/native:linux_aarch64_gnu_2_28": "linux-arm64-gnu",
}
NATIVE_EXTENSION_PROFILES = _LINUX_PROFILES | {
    "//build_defs/native:macos_arm64": "macos-arm64",
    "//build_defs/native:windows_x64": "windows-x64-msvc",
}

NATIVE_EXTENSION_CONFIGURATION = select(NATIVE_EXTENSION_PROFILES, no_match_error = "No extension construction profile for this native platform.")
NATIVE_EXTENSION_COMPATIBLE = select({condition: [] for condition in NATIVE_EXTENSION_PROFILES} | {
    "//conditions:default": ["@platforms//:incompatible"],
})
NATIVE_EXTENSION_LINUX_COMPATIBLE = select({condition: [] for condition in _LINUX_PROFILES} | {
    "//conditions:default": ["@platforms//:incompatible"],
})
