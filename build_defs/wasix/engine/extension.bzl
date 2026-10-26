"""Engine acquisition has a stable namespace independent of other repository rules."""

load(":acquisition.bzl", "engine_acquisition_repository", "engine_notices_repository")
load(":repositories.bzl", "engine_relink_sources_repository", "wasix_engine_sources_repository", "windows_wee8_repository")

_REPOSITORIES = ["wasix_engine_sources", "windows_wee8", "wasix_engine_acquisition", "wasix_engine_notices", "wasix_engine_relink_sources"]

def _impl(ctx):
    wasix_engine_sources_repository(name = "wasix_engine_sources")
    windows_wee8_repository(name = "windows_wee8")
    engine_acquisition_repository(name = "wasix_engine_acquisition")
    engine_notices_repository(name = "wasix_engine_notices")
    engine_relink_sources_repository(name = "wasix_engine_relink_sources")
    return ctx.extension_metadata(root_module_direct_deps = _REPOSITORIES, root_module_direct_dev_deps = [], reproducible = True)

engine_repositories = module_extension(implementation = _impl)
