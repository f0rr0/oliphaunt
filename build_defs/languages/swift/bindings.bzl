"""Declared UniFFI generation from the native mobile library's metadata."""

load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")

def _uniffi_swift_impl(ctx):
    library = ctx.file.library
    swift = ctx.actions.declare_file(ctx.label.name + "/OliphauntNativeBindings.swift")
    header = ctx.actions.declare_file(ctx.label.name + "/OliphauntNativeBindingsFFI.h")
    modulemap = ctx.actions.declare_file(ctx.label.name + "/OliphauntNativeBindingsFFI.modulemap")
    bun_file_action(
        ctx,
        entry_point = ctx.file.driver,
        source_files = [ctx.file.driver, ctx.file._invocation],
        arguments = [ctx.executable.generator.path, library.path, ctx.file.configuration.path, swift.dirname],
        inputs = [ctx.file.driver, ctx.file._invocation, library, ctx.file.configuration],
        tools = [ctx.attr.generator[DefaultInfo].files_to_run],
        outputs = [swift, header, modulemap],
        mnemonic = "OliphauntUniFfiSwift",
        use_default_shell_env = False,
    )
    return [DefaultInfo(files = depset([swift, header, modulemap])), OutputGroupInfo(swift = depset([swift]), header = depset([header]), modulemap = depset([modulemap]))]

uniffi_swift = rule(
    implementation = _uniffi_swift_impl,
    attrs = {
        "library": attr.label(mandatory = True, allow_single_file = [".so", ".dylib", ".rlib"], cfg = "exec"),
        "generator": attr.label(mandatory = True, executable = True, cfg = "exec"),
        "configuration": attr.label(mandatory = True, allow_single_file = [".toml"]),
        "driver": attr.label(default = Label("//build_defs/languages/swift:generate.mts"), allow_single_file = True),
        "_invocation": attr.label(default = Label("//build_defs/languages:uniffi.mts"), allow_single_file = True),
    },
    toolchains = BUN_SOURCE_TOOLCHAINS,
)

def _uniffi_output_impl(ctx):
    return [DefaultInfo(files = getattr(ctx.attr.bindings[OutputGroupInfo], ctx.attr.group))]

# Generation uses one host metadata variant for every target slice. Keeping
# this edge in the execution configuration avoids three identical generators
# when Apple's XCFramework rule splits its header dependency by platform.
uniffi_output = rule(
    implementation = _uniffi_output_impl,
    attrs = {
        "bindings": attr.label(mandatory = True, providers = [OutputGroupInfo], cfg = "exec"),
        "group": attr.string(mandatory = True, values = ["swift", "header", "modulemap"]),
    },
)
