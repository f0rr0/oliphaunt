"""Kotlin bindings from the same declared Unix mobile metadata and UniFFI CLI."""

load("//build_defs/foundation:bun-toolchain.bzl", "BUN_TOOLCHAIN_TYPE")

def _uniffi_kotlin_impl(ctx):
    library = ctx.file.library
    output = ctx.actions.declare_file(ctx.label.name + "/dev/oliphaunt/bindings/oliphaunt_mobile_bindings.kt")
    bun = ctx.toolchains[BUN_TOOLCHAIN_TYPE].bun
    ctx.actions.run(
        executable = bun,
        arguments = [ctx.file.driver.path, ctx.executable.generator.path, library.path, ctx.file.configuration.path, output.dirname.removesuffix("/dev/oliphaunt/bindings")],
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
        "library": attr.label(mandatory = True, allow_single_file = [".so", ".dylib"], cfg = "exec"),
        "generator": attr.label(mandatory = True, executable = True, cfg = "exec"),
        "configuration": attr.label(mandatory = True, allow_single_file = [".toml"]),
        "driver": attr.label(default = Label("//build_defs/languages/jvm:generate-kotlin.mts"), allow_single_file = True),
        "helper": attr.label(default = Label("//build_defs/languages:uniffi.mts"), allow_single_file = True),
    },
    toolchains = [BUN_TOOLCHAIN_TYPE],
)
