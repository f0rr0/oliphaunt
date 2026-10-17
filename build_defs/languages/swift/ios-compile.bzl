"""The conventional broker and React Native iOS compiler qualification."""

load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")

def _runfile(ctx, file):
    return file.short_path[3:] if file.short_path.startswith("../") else ctx.workspace_name + "/" + file.short_path

def _ios_compile_impl(ctx):
    modules = {}
    for module in ["OliphauntCore", "Oliphaunt", "OliphauntBroker", "OliphauntBrokerExtension"]:
        files = [file for file in ctx.files.sources if "/Sources/" + module + "/" in file.short_path]
        if not files:
            fail("iOS compiler qualification requires the original " + module + " sources")
        modules[module] = [_runfile(ctx, file) for file in files]
    files = [ctx.file.generated_swift, ctx.file.ffi_header, ctx.file.ffi_modulemap, ctx.file.public_header,
             ctx.file.c_header, ctx.file.c_modulemap, ctx.file.extension_template, ctx.file.host_template,
             ctx.file.adapter, ctx.file.adapter_header]
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode({
        "modules": modules,
        "generatedSwift": _runfile(ctx, ctx.file.generated_swift),
        "ffiHeader": _runfile(ctx, ctx.file.ffi_header),
        "ffiModulemap": _runfile(ctx, ctx.file.ffi_modulemap),
        "publicHeader": _runfile(ctx, ctx.file.public_header),
        "cHeader": _runfile(ctx, ctx.file.c_header),
        "cModulemap": _runfile(ctx, ctx.file.c_modulemap),
        "extensionTemplate": _runfile(ctx, ctx.file.extension_template),
        "hostTemplate": _runfile(ctx, ctx.file.host_template),
        "adapter": _runfile(ctx, ctx.file.adapter),
        "adapterHeader": _runfile(ctx, ctx.file.adapter_header),
    }))
    if not ctx.files._sdk:
        fail("iOS compiler qualification requires the declared iPhoneOS SDK")
    return bun_test_entrypoint(ctx, ctx.file._runner,
        [specification, ctx.file._compiler, ctx.files._sdk[0], ctx.file._receipt],
        files + ctx.files.sources + ctx.files._sdk + ctx.files._toolchain + ctx.files._platform + [ctx.file._compiler, ctx.file._receipt, specification],
        source_files = [ctx.file._runner], runfiles_environment = ["OLIPHAUNT_BAZEL_RUNFILES"])

_swift_ios_compile_test = rule(
    implementation = _ios_compile_impl,
    test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "sources": attr.label_list(mandatory = True, allow_files = [".swift"]),
        "generated_swift": attr.label(mandatory = True, allow_single_file = [".swift"]),
        "ffi_header": attr.label(mandatory = True, allow_single_file = [".h"]),
        "ffi_modulemap": attr.label(mandatory = True, allow_single_file = True),
        "public_header": attr.label(default = Label("//src/native/runtime:include/oliphaunt.h"), allow_single_file = True),
        "c_header": attr.label(mandatory = True, allow_single_file = True),
        "c_modulemap": attr.label(mandatory = True, allow_single_file = True),
        "extension_template": attr.label(mandatory = True, allow_single_file = True),
        "host_template": attr.label(mandatory = True, allow_single_file = True),
        "adapter": attr.label(default = Label("//src/native/sdks/react-native:ios/OliphauntAdapter.swift"), allow_single_file = True),
        "adapter_header": attr.label(default = Label("//src/native/sdks/react-native:ios/OliphauntAdapter.h"), allow_single_file = True),
        "_runner": attr.label(default = Label("//build_defs/languages/swift:ios-compile-test.mts"), allow_single_file = True),
        "_compiler": attr.label(default = Label("@native_apple_sdk//:tools/swiftc_files"), allow_single_file = True),
        "_receipt": attr.label(default = Label("@native_apple_sdk//:receipt.json"), allow_single_file = True),
        "_sdk": attr.label(default = Label("@native_apple_sdk//:sdk_iphoneos_files")),
        "_toolchain": attr.label(default = Label("@native_apple_sdk//:toolchain_files")),
        "_platform": attr.label_list(default = [Label("@native_apple_sdk//:platform_iphoneos/Library_files"), Label("@native_apple_sdk//:platform_iphoneos/usr/lib_files")]),
    }),
)

def swift_ios_compile_test(name, args = [], **kwargs):
    _swift_ios_compile_test(name = name, args = bun_test_entrypoint_args(name) + args, **kwargs)
