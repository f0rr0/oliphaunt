"""Finite original Expo Apple module declarations, compiled by maintained rules."""
load("@bazel_skylib//rules:write_file.bzl", "write_file")
load("@rules_swift//swift:swift_library.bzl", "swift_library")
load("@rules_swift//swift:swift_interop_hint.bzl", "swift_interop_hint")
load("@rules_cc//cc:defs.bzl", "cc_library")
load("@rules_cc//cc:objc_library.bzl", "objc_library")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")
load("@rules_apple//apple:apple.bzl", "apple_dynamic_xcframework_import")
load("@rules_apple//apple:resources.bzl", "apple_resource_bundle")
load("@rules_apple//apple:ios.bzl", "ios_dynamic_framework")

def _react_headers_impl(ctx):
    overlay = ctx.actions.declare_file(ctx.label.name + ".yaml")
    ctx.actions.expand_template(template = ctx.file.template, output = overlay,
        substitutions = {"${ROOT_PATH}": ctx.file.template.dirname})
    # RN ships this precise legacy-header overlay alongside its genuine framework.
    prefix = ctx.file.template.dirname + "/Headers"
    hermes = ctx.file.hermes_header.dirname.removesuffix("/hermes")
    dependencies = ctx.file.dependencies_header.dirname.removesuffix("/folly")
    swift_headers = ctx.file.swift_bridging.dirname.removesuffix("/swift")
    return [
        DefaultInfo(files = depset([overlay])),
        CcInfo(compilation_context = cc_common.create_compilation_context(
            headers = depset(ctx.files.headers + ctx.files.swift_headers + [overlay]),
            system_includes = depset([prefix, hermes, dependencies, swift_headers]),
        )),
    ]

react_apple_headers = rule(implementation = _react_headers_impl, attrs = {
    "template": attr.label(mandatory = True, allow_single_file = [".yaml"]),
    "hermes_header": attr.label(mandatory = True, allow_single_file = [".h"]),
    "dependencies_header": attr.label(mandatory = True, allow_single_file = [".h"]),
    "headers": attr.label_list(mandatory = True, allow_files = True),
    "swift_bridging": attr.label(mandatory = True, allow_single_file = True),
    "swift_headers": attr.label_list(mandatory = True, allow_files = True),
})

def react_apple_swift_copts(react_headers):
    """Keep RN's C++ import context when rebuilding textual Swift interfaces."""
    return [
        "-cxx-interoperability-mode=default", "-Xcc", "-std=c++20",
        "-Xcc", "-ivfsoverlay", "-Xcc", "$(location " + react_headers + ")",
        "-Xfrontend", "-strict-implicit-module-context",
    ]

def expo_apple_swift_library(name, hdrs = [], **kwargs):
    """Preserve CocoaPods' implicit UIKit umbrella, including headerless pods."""
    umbrella = name + "_pod_umbrella"
    write_file(
        name = umbrella,
        out = umbrella + ".h",
        content = ["#ifdef __OBJC__", "#import <UIKit/UIKit.h>", "#endif", ""],
        testonly = kwargs.get("testonly", False),
        target_compatible_with = kwargs.get("target_compatible_with", []),
        visibility = ["//visibility:private"],
    )
    swift_library(name = name, hdrs = hdrs + [":" + umbrella], **kwargs)

_SQLITE = ["HAVE_USLEEP=1", "SQLITE_ENABLE_LOCKING_STYLE=0", "SQLITE_ENABLE_BYTECODE_VTAB=1",
    "SQLITE_TEMP_STORE=2", "SQLITE_ENABLE_SESSION=1", "SQLITE_ENABLE_PREUPDATE_HOOK=1",
    "SQLITE_ENABLE_MATH_FUNCTIONS=1", "SQLITE_ENABLE_FTS4=1", "SQLITE_ENABLE_FTS3_PARENTHESIS=1", "SQLITE_ENABLE_FTS5=1"]

def expo_apple_modules(metadata, react, hermes, dependencies, react_headers, react_jsi_headers, app_dependency_provider, app_codegen, constants_config):
    """Build the real release closure declared by the exact original Apple resolve."""
    common = [react, hermes, dependencies, react_headers]
    overlay = "$(location " + react_headers + ")"
    headers = "external/" + native.repository_name().removeprefix("@") + "/apple-headers"
    clang = ["-ivfsoverlay", overlay, "-I" + headers, "-DREACT_NATIVE_MINOR_VERSION=" + metadata["reactNativeVersion"].split(".")[1], "-DRCT_NEW_ARCH_ENABLED=1"] + metadata["follyCompilerFlags"]
    swift = react_apple_swift_copts(react_headers) + ["-Xcc", "-I" + headers] + [flag for option in metadata["follyCompilerFlags"] for flag in ["-Xcc", option]]
    root = metadata["jsiRoot"] + "/apple"
    swift_interop_hint(name = "jsi_module_hint", module_name = "jsi")
    cc_library(name = "jsi_module", hdrs = [react_jsi_headers], deps = common, aspect_hints = [":jsi_module_hint"])
    swift_interop_hint(name = "ExpoModulesJSI_Cxx_module", module_name = "ExpoModulesJSI_Cxx")
    cc_library(
        name = "ExpoModulesJSI_Cxx", srcs = native.glob([root + "/Sources/ExpoModulesJSI-Cxx/*.cpp"]),
        hdrs = native.glob([root + "/Sources/ExpoModulesJSI-Cxx/include/*.h"]),
        includes = [root + "/Sources/ExpoModulesJSI-Cxx/include"], aspect_hints = [":ExpoModulesJSI_Cxx_module"],
        deps = common, copts = ["-std=c++20"] + clang, additional_compiler_inputs = [react_headers],
    )
    swift_library(
        name = "ExpoModulesJSI_sources", module_name = "ExpoModulesJSI",
        srcs = native.glob([root + "/Sources/ExpoModulesJSI/**/*.swift"]),
        deps = [":ExpoModulesJSI_Cxx", ":jsi_module"] + common,
        copts = ["-swift-version", "6", "-enable-upcoming-feature", "NonisolatedNonsendingByDefault",
            "-enable-upcoming-feature", "InferIsolatedConformances", "-no-verify-emitted-module-interface",
            "-Xfrontend", "-clang-header-expose-decls=has-expose-attr"] + swift +
            ["-Xcc", "-iapinotes-modules", "-Xcc", "external/" + native.repository_name().removeprefix("@") + "/" + root + "/APINotes"],
        swiftc_inputs = [react_headers] + native.glob([root + "/APINotes/**"]),
        library_evolution = True,
    )
    ios_dynamic_framework(name = "ExpoModulesJSI", bundle_id = "expo.modules.jsi", minimum_os_version = "17.0",
        families = ["iphone"], infoplists = [Label("//build_defs/apple:framework-info.plist")],
        deps = [":ExpoModulesJSI_sources"], tags = ["no-remote"], visibility = ["//visibility:public"])
    for row in metadata["frameworks"]:
        apple_dynamic_xcframework_import(
            name = row["module"], xcframework_imports = native.glob(["apple-prebuilt/" + row["module"] + ".xcframework/**"], exclude = ["**/._*"]),
            deps = [":ExpoModulesJSI_sources"] if row["module"] == "ExpoModulesCore" else [":ExpoModulesCore", ":ExpoModulesJSI_sources"],
        )
        if row["privacy"]:
            apple_resource_bundle(name = row["module"] + "_privacy", bundle_name = row["module"] + "_privacy", resources = row["privacy"])
    for row in metadata["modules"]:
        defines = _SQLITE if row["module"] == "ExpoSQLite" else []
        extra = [metadata["sqliteRoot"] + "/vendor/sqlite3/sqlite3.c", metadata["sqliteRoot"] + "/vendor/sqlite3/sqlite3.h"] if defines else []
        sqlite_headers = "external/" + native.repository_name().removeprefix("@") + "/" + metadata["sqliteRoot"] + "/vendor/sqlite3"
        deps = [app_dependency_provider if dep.startswith("@app//") else react if dep == "React" else ":ExpoModulesJSI_sources" if dep == "ExpoModulesJSI" else ":" + dep for dep in row["deps"]]
        if not any([source.endswith(".swift") for source in row["sources"]]):
            objc_library(name = row["module"], module_name = row["module"], enable_modules = True,
                srcs = row["sources"] + row["privateHeaders"], hdrs = row["headers"],
                deps = deps + [react_headers], alwayslink = True, copts = clang,
                data = [react_headers])
            continue
        expo_apple_swift_library(
            name = row["module"], module_name = row["module"],
            srcs = row["sources"] + row["privateHeaders"] + extra, hdrs = row["headers"],
            deps = deps + [react_headers], alwayslink = True, generates_header = True,
            generated_header_name = row["module"] + "-Swift.h",
            copts = ["-swift-version", row.get("swift", "5")] + swift + (["-Xcc", "-I" + sqlite_headers] + [flag for define in defines for flag in ["-Xcc", "-D" + define]] if defines else []),
            c_copts = clang + ["-D" + define for define in defines] + (["-I" + sqlite_headers] if defines else []), swiftc_inputs = [react_headers],
        )
        if row["privacy"]:
            apple_resource_bundle(name = row["module"] + "_privacy", bundle_name = row["module"] + "_privacy",
                resources = row["privacy"])
    safe_area = metadata["safeAreaRoot"]
    objc_library(name = "SafeAreaContext", srcs = native.glob([safe_area + "/ios/**/*.m", safe_area + "/ios/**/*.mm", safe_area + "/common/cpp/**/*.cpp"]),
        hdrs = native.glob([safe_area + "/ios/**/*.h", safe_area + "/common/cpp/**/*.h"]),
        includes = [safe_area + "/ios", safe_area + "/ios/Fabric", safe_area + "/common/cpp"],
        deps = common + [app_codegen], defines = ["RCT_NEW_ARCH_ENABLED=1"], alwayslink = True,
        copts = clang, data = [react_headers])
    # Release-only wrapper: the original podspec has no compiled sources.
    native.alias(name = "expo_dev_client", actual = ":expo_dev_menu_interface")
    apple_resource_bundle(name = "EXConstants_config", bundle_name = "EXConstants", resources = [constants_config])
