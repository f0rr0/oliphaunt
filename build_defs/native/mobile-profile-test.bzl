"""Configured selector and builtin link regressions; these do not execute binaries."""

load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts")
load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")
load(":platform_config.bzl", "NATIVE_BACKEND_PORT_SOURCES", "NATIVE_BUILTIN_SNOWBALL", "NATIVE_C_COMPATIBLE", "NATIVE_COMPATIBLE", "NATIVE_CONFIGURATION", "NATIVE_CONFIGURATION_ADMISSION", "NATIVE_ELF_C_COMPATIBLE", "NATIVE_EMBEDDED_DEFINES", "NATIVE_HEADER_DEFINES", "NATIVE_INCLUDE_DIRECTORIES", "NATIVE_LINKOPTS")

_VALUES = {
    "ports": NATIVE_BACKEND_PORT_SOURCES,
    "snowball": NATIVE_BUILTIN_SNOWBALL,
    "c_compatible": NATIVE_C_COMPATIBLE,
    "desktop_compatible": NATIVE_COMPATIBLE,
    "configuration": NATIVE_CONFIGURATION,
    "admission": NATIVE_CONFIGURATION_ADMISSION,
    "elf_compatible": NATIVE_ELF_C_COMPATIBLE,
    "embedded_defines": NATIVE_EMBEDDED_DEFINES,
    "header_defines": NATIVE_HEADER_DEFINES,
    "includes": NATIVE_INCLUDE_DIRECTORIES,
    "linkopts": NATIVE_LINKOPTS,
}
_ProfileInfo = provider(fields = ["values"])

def _profile_impl(ctx):
    return [_ProfileInfo(values = {name: getattr(ctx.attr, name) for name in _VALUES})]

_profile = rule(implementation = _profile_impl, attrs = {name: attr.string_list() for name in _VALUES})

def _ios_profile_test(ctx):
    env = analysistest.begin(ctx)
    values = analysistest.target_under_test(env)[_ProfileInfo].values
    asserts.equals(env, [], values["c_compatible"])
    asserts.equals(env, ["@platforms//:incompatible"], values["desktop_compatible"])
    asserts.equals(env, ["@platforms//:incompatible"], values["elf_compatible"])
    asserts.equals(env, ["src/backend/port/oliphaunt_embedded_sema.c", "src/backend/port/oliphaunt_embedded_shmem.c"], values["ports"])
    asserts.equals(env, ["OLIPHAUNT_EMBEDDED_MOBILE_SHMEM"], values["embedded_defines"])
    asserts.equals(env, ["OLIPHAUNT_BUILTIN_DICT_SNOWBALL"], values["snowball"])
    asserts.equals(env, ["_DARWIN_C_SOURCE"], values["header_defines"])
    asserts.equals(env, [], values["linkopts"])
    asserts.equals(env, [":host_" + ctx.attr.profile + "_configuration"], values["configuration"])
    asserts.equals(env, [":host_" + ctx.attr.profile + "_admission"], values["admission"])
    asserts.equals(env, ["host_" + ctx.attr.profile + "/src/include"], values["includes"])
    return analysistest.end(env)

_device_test = analysistest.make(_ios_profile_test, attrs = {"profile": attr.string(default = "ios")}, config_settings = {"//command_line_option:platforms": str(Label("//build_defs/host:ios_device_arm64"))})
_simulator_test = analysistest.make(_ios_profile_test, attrs = {"profile": attr.string(default = "ios_simulator")}, config_settings = {"//command_line_option:platforms": str(Label("//build_defs/host:ios_simulator_arm64"))})

def _builtin_link_test_impl(ctx):
    env = analysistest.begin(ctx)
    wrapper = analysistest.target_under_test(env)
    compilation = wrapper[CcInfo].compilation_context
    defines = compilation.defines.to_list()
    asserts.true(env, "OLIPHAUNT_BUILTIN_PLPGSQL" in defines)
    asserts.equals(env, ctx.attr.snowball, "OLIPHAUNT_BUILTIN_DICT_SNOWBALL" in defines)
    expected = {
        Label("@postgres//:plpgsql_embedded"): not ctx.attr.windows,
        Label("@postgres//:plpgsql_builtin_windows"): ctx.attr.windows,
        Label("@postgres//:snowball_builtin"): ctx.attr.snowball,
    }
    inputs = wrapper[CcInfo].linking_context.linker_inputs.to_list()
    for owner, needed in expected.items():
        libraries = [library for entry in inputs if entry.owner == owner for library in entry.libraries]
        asserts.equals(env, needed, len(libraries) > 0, "builtin define and library must agree: " + str(owner))
        for library in libraries:
            asserts.true(env, library.alwayslink, "builtin registration must survive linking: " + str(owner))
            asserts.true(env, library.static_library != None or library.pic_static_library != None, "builtin must contribute its actual archive: " + str(owner))
    asserts.false(env, any([file.basename == "pg_config.h" for file in compilation.headers.to_list()]), "private builtin headers must not escape through the public wrapper")
    return analysistest.end(env)

_BUILTIN_ATTRS = {"windows": attr.bool(default = False), "snowball": attr.bool(default = False)}
_builtin_link_test = analysistest.make(_builtin_link_test_impl, attrs = _BUILTIN_ATTRS)
_device_builtin_link_test = analysistest.make(_builtin_link_test_impl, attrs = _BUILTIN_ATTRS, config_settings = {"//command_line_option:platforms": str(Label("//build_defs/host:ios_device_arm64"))})
_simulator_builtin_link_test = analysistest.make(_builtin_link_test_impl, attrs = _BUILTIN_ATTRS, config_settings = {"//command_line_option:platforms": str(Label("//build_defs/host:ios_simulator_arm64"))})

def native_mobile_profile_tests():
    _profile(name = "mobile_profile_subject", **_VALUES)
    _device_test(name = "ios_device_profile_test", target_under_test = ":mobile_profile_subject")
    _simulator_test(name = "ios_simulator_profile_test", target_under_test = ":mobile_profile_subject")
    _builtin_link_test(
        name = "runtime_builtin_link_test",
        target_under_test = "//src/native/runtime:wrapper",
        windows = select({":windows_x64": True, "//conditions:default": False}),
        snowball = select({":android": True, ":ios": True, "//conditions:default": False}),
        size = "small",
    )
    for test, name in [(_device_builtin_link_test, "ios_device_builtin_link_test"), (_simulator_builtin_link_test, "ios_simulator_builtin_link_test")]:
        test(name = name, target_under_test = "//src/native/runtime:wrapper", snowball = True, target_compatible_with = ["@platforms//os:macos", "@platforms//cpu:aarch64"], size = "small")
