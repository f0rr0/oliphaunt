"""Kotlin bindings from the same declared Unix mobile metadata and UniFFI CLI."""

load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")

def _uniffi_kotlin_impl(ctx):
    library = ctx.file.library
    output = ctx.actions.declare_file(ctx.label.name + "/dev/oliphaunt/bindings/oliphaunt_mobile_bindings.kt")
    bun_file_action(
        ctx,
        entry_point = ctx.file.driver,
        source_files = [ctx.file.driver, ctx.file.helper],
        arguments = [ctx.executable.generator.path, library.path, ctx.file.configuration.path, output.dirname.removesuffix("/dev/oliphaunt/bindings")],
        inputs = [ctx.file.driver, ctx.file.helper, library, ctx.file.configuration],
        tools = [ctx.attr.generator[DefaultInfo].files_to_run],
        outputs = [output],
        mnemonic = "OliphauntUniFfiKotlin",
        use_default_shell_env = False,
    )
    return [DefaultInfo(files = depset([output]))]

uniffi_kotlin = rule(
    implementation = _uniffi_kotlin_impl,
    attrs = {
        "library": attr.label(mandatory = True, allow_single_file = [".so", ".dylib", ".rlib"], cfg = "exec"),
        "generator": attr.label(mandatory = True, executable = True, cfg = "exec"),
        "configuration": attr.label(mandatory = True, allow_single_file = [".toml"]),
        "driver": attr.label(default = Label("//build_defs/languages/jvm:generate-kotlin.mts"), allow_single_file = True),
        "helper": attr.label(default = Label("//build_defs/languages:uniffi.mts"), allow_single_file = True),
    },
    toolchains = BUN_SOURCE_TOOLCHAINS,
)
