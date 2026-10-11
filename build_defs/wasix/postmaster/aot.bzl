"""One declared LLVM compilation and admission check per sealed module."""

load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")

def _aot_impl(ctx):
    sealed = ctx.file.sealed
    if not sealed.is_directory:
        fail("Postmaster AOT requires the real sealed module TreeArtifact")
    relative = ctx.attr.module_path
    if not relative or relative.startswith("/") or any([part in ["", ".", ".."] for part in relative.split("/")]):
        fail("Invalid sealed module path: " + relative)
    artifact = ctx.actions.declare_file(ctx.label.name + ".bin")
    receipt = ctx.actions.declare_file(ctx.label.name + ".json")
    arguments = ctx.actions.args()
    arguments.add_all([ctx.executable._compiler, ctx.file._abi, sealed, relative, artifact, receipt], expand_directories = False)
    bun_file_action(
        ctx,
        ctx.file._writer,
        arguments = [arguments],
        source_files = [ctx.file._writer],
        inputs = [sealed, ctx.file._abi],
        tools = [ctx.attr._compiler[DefaultInfo].files_to_run],
        outputs = [artifact, receipt],
        mnemonic = "PostmasterLlvmAot",
        progress_message = "Compile and verify sealed postmaster AOT %{label}",
        resource_set = _resources,
    )
    return [DefaultInfo(files = depset([artifact])), OutputGroupInfo(receipt = depset([receipt]))]

def _resources(_os, _input_count):
    return {"cpu": 1, "memory": 4096}

postmaster_aot = rule(
    implementation = _aot_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "sealed": attr.label(mandatory = True, allow_single_file = True),
        "module_path": attr.string(mandatory = True),
        "_compiler": attr.label(default = "//src/wasix/postmaster:compiler", cfg = "exec", executable = True),
        "_abi": attr.label(default = "//src/wasix/postmaster:runtime_abi_contract", cfg = "exec", allow_single_file = True),
        "_writer": attr.label(default = "//build_defs/wasix/postmaster:aot.mts", allow_single_file = True),
    },
)
