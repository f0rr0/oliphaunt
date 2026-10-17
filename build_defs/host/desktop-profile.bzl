"""Desktop artifacts retain their contract when consumed by Apple packages."""

_PLATFORMS = "//command_line_option:platforms"
_PACKAGE = Label("//build_defs/host:apple_package_macos_arm64")
_DESKTOP = Label("//build_defs/host:native_macos_arm64")

def _desktop_profile_impl(settings, _attr):
    return {_PLATFORMS: [str(_DESKTOP) if Label(str(platform)) == _PACKAGE else str(platform) for platform in settings[_PLATFORMS]]}

desktop_profile = transition(implementation = _desktop_profile_impl, inputs = [_PLATFORMS], outputs = [_PLATFORMS])
