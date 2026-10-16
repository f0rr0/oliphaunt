"""Actual Windows module actions must agree on their static/shared boundary."""

load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts")
load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")
load("@rules_cc//cc/common:cc_shared_library_info.bzl", "CcSharedLibraryInfo")
load("//build_defs/native:platform_config.bzl", "NATIVE_WINDOWS_COMPATIBLE")

def _objects(linker_input):
    result = []
    for library in linker_input.libraries:
        result.extend((library.pic_objects if library.pic_static_library else library.objects) or [])
    return result

def _impl(ctx):
    env = analysistest.begin(ctx)
    target = analysistest.target_under_test(env)
    asserts.equals(env, [ctx.attr.dll_name], [file.basename for file in target[DefaultInfo].files.to_list()])
    asserts.true(env, CcSharedLibraryInfo in target, "Windows modules must use the stock shared-library ownership rule")
    if CcSharedLibraryInfo not in target:
        return analysistest.end(env)
    actions = analysistest.target_actions(env)
    parsers = [action for action in actions if action.mnemonic == "DefParser"]
    links = [action for action in actions if action.mnemonic == "CppLink"]
    asserts.equals(env, 1, len(parsers))
    asserts.equals(env, 1, len(links))
    if len(parsers) != 1 or len(links) != 1:
        return analysistest.end(env)
    definition_inputs = {file.path: True for file in parsers[0].inputs.to_list()}
    for library in ctx.attr.static_libraries:
        own_objects = [file for entry in library[CcInfo].linking_context.linker_inputs.to_list() if entry.owner == library.label for file in _objects(entry)]
        asserts.true(env, len(own_objects) > 0, "static module fixture must contribute actual compiled objects: " + str(library.label))
        for file in own_objects:
            asserts.true(env, file.path in definition_inputs, "static module object missing from DEF: " + file.path)
    link_inputs = {file.path: True for file in links[0].inputs.to_list()}
    for file in parsers[0].outputs.to_list():
        asserts.true(env, file.path in link_inputs, "link must consume the actual stock-generated DEF")
    asserts.true(env, ctx.file.runtime_interface.path in link_inputs, "link must retain its actual PostgreSQL ABI import library")
    asserts.false(env, any(["liboliphaunt_postgis_deps" in file.basename for file in links[0].inputs.to_list()]), "Windows PostGIS must incorporate its dependency objects without a private DLL import")
    return analysistest.end(env)

_test = analysistest.make(_impl, attrs = {
    "dll_name": attr.string(mandatory = True),
    "static_libraries": attr.label_list(mandatory = True, providers = [CcInfo]),
    "runtime_interface": attr.label(mandatory = True, allow_single_file = True),
})

def _crypto_impl(ctx):
    env = analysistest.begin(ctx)
    target = analysistest.target_under_test(env)
    crypto = ctx.attr.crypto
    expected = ["ws2_32.lib", "gdi32.lib", "advapi32.lib", "crypt32.lib", "user32.lib"]
    owner_flags = [flag for entry in crypto[CcInfo].linking_context.linker_inputs.to_list() if entry.owner == crypto.label for flag in entry.user_link_flags]
    asserts.equals(env, sorted(expected), sorted(owner_flags), "libcrypto must own its canonical Windows system requirements")
    asserts.equals(env, [ctx.attr.dll_name], [file.basename for file in target[DefaultInfo].files.to_list()])
    asserts.true(env, CcSharedLibraryInfo in target, "pgcrypto must retain the stock module rule")
    links = [action for action in analysistest.target_actions(env) if action.mnemonic == "CppLink"]
    asserts.equals(env, 1, len(links))
    if len(links) == 1:
        for flag in expected:
            asserts.true(env, flag in links[0].argv, "libcrypto system requirement missing from actual pgcrypto link: " + flag)
    return analysistest.end(env)

_crypto_test = analysistest.make(_crypto_impl, attrs = {
    "crypto": attr.label(mandatory = True, providers = [CcInfo]),
    "dll_name": attr.string(mandatory = True),
})

def native_windows_module_tests():
    for variant in ["server", "embedded"]:
        objects = "//src/extensions/external/postgis:postgis_" + variant + "_objects"
        _test(
            name = "postgis_" + variant + "_windows_link_test",
            target_under_test = "//src/extensions/external/postgis:postgis_" + variant + ".dll",
            dll_name = "postgis_" + variant + ".dll",
            static_libraries = [objects, "//build_defs/extensions/postgis:postgis_lwgeom", "//build_defs/extensions/postgis:postgis_flatgeobuf"] + ["//build_defs/extensions/postgis:" + name for name in ["geos", "proj", "json_c", "libxml2", "iconv", "sqlite"]],
            runtime_interface = "@postgres//:server_windows_interface" if variant == "server" else "//src/native/runtime:runtime_windows_interface",
            target_compatible_with = NATIVE_WINDOWS_COMPATIBLE,
            size = "small",
        )
        _crypto_test(
            name = "pgcrypto_" + variant + "_windows_link_test",
            target_under_test = "//src/extensions/contrib:pgcrypto_" + variant + ".dll",
            dll_name = "pgcrypto_" + variant + ".dll",
            crypto = "@openssl//:crypto",
            target_compatible_with = NATIVE_WINDOWS_COMPATIBLE,
            size = "small",
        )
