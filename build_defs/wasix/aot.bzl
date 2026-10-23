"""Native, Linux-first Wasmer LLVM serialization for canonical target triples.

Cross-target construction remains distinct from the required target-host
deserialize, query and reopen consumer proofs.
"""

load("@wasix_tool_metadata//:targets.bzl", "WASIX_AOT_TARGETS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")
load(":wasm.bzl", "WasmModuleInfo")
load(":platform.bzl", "WASIX_PORTABLE_TRANSITION")

WasixAotInfo = provider(fields = {
    "image": "Zstandard-compressed Wasmer serialized module.",
    "module": "The original portable module.",
    "target": "The exact canonical target triple.",
})

def _resources(_os, _input_count):
    return {"cpu": 2, "memory": 8192}

def _aot_impl(ctx):
    if ctx.attr.target_id not in WASIX_AOT_TARGETS:
        fail("WASIX AOT requires an admitted canonical target: " + ctx.attr.target_id)
    target = WASIX_AOT_TARGETS[ctx.attr.target_id]
    module = ctx.attr.module[0][WasmModuleInfo].module
    output = ctx.actions.declare_file(ctx.label.name + "/" + ctx.attr.output_name)
    arguments = ctx.actions.args()
    arguments.add_all(["aot-serializer", "serialize"])
    arguments.add("--input", module)
    arguments.add("--output", output)
    arguments.add("--target", target)
    arguments.add_all(["--threads", "2"])
    ctx.actions.run(
        executable = ctx.attr._serializer[DefaultInfo].files_to_run,
        arguments = [arguments],
        inputs = [module],
        outputs = [output],
        env = {"LC_ALL": "C"},
        mnemonic = "WasixAotSerialize",
        progress_message = "Serialize WASIX AOT " + ctx.attr.target_id + " %{label}",
        resource_set = _resources,
    )
    return [
        DefaultInfo(files = depset([output])),
        WasixAotInfo(image = output, module = module, target = target),
    ]

wasix_aot = rule(
    implementation = _aot_impl,
    attrs = {
        "module": attr.label(providers = [WasmModuleInfo], mandatory = True, cfg = WASIX_PORTABLE_TRANSITION),
        "target_id": attr.string(mandatory = True),
        "output_name": attr.string(mandatory = True),
        "_serializer": attr.label(default = "//src/wasix/runtime/tools/xtask:aot_serializer", executable = True, cfg = "exec"),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    },
)

def _aot_payload_impl(ctx):
    if ctx.attr.target_id not in WASIX_AOT_TARGETS:
        fail("WASIX AOT requires an admitted canonical target: " + ctx.attr.target_id)
    target = WASIX_AOT_TARGETS[ctx.attr.target_id]
    portable = ctx.attr.portable[DefaultInfo].files.to_list()
    if len(portable) != 1 or not portable[0].is_directory:
        fail("AOT requires the declared portable runtime directory")
    inputs = portable + [ctx.file.toolchain]
    artifacts = []
    for label, name in ctx.attr.artifacts.items():
        artifact = label[WasixAotInfo]
        if artifact.target != target:
            fail("AOT payload cannot mix serializer target triples")
        inputs += [artifact.image, artifact.module]
        artifacts.append({"name": name, "path": artifact.image.basename, "image": artifact.image.path, "module": artifact.module.path})
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({
        "portable_manifest": portable[0].path + "/manifest.json",
        "toolchain": ctx.file.toolchain.path,
        "target_triple": target,
        "artifacts": artifacts,
    }))
    output = ctx.actions.declare_directory(ctx.label.name + "/" + target)
    args = ctx.actions.args()
    args.add("--spec", spec)
    args.add("--output", output.path)
    args.add("--manifest-tool", ctx.executable._manifest_tool)
    bun_file_action(
        ctx,
        ctx.file._packager,
        arguments = [args],
        inputs = depset(inputs + [spec]),
        source_files = [],
        tools = [ctx.attr._manifest_tool[DefaultInfo].files_to_run],
        outputs = [output],
        env = {"LC_ALL": "C"},
        mnemonic = "WasixAotEnvelope",
        progress_message = "Package declared WASIX AOT " + ctx.attr.target_id + " %{label}",
    )
    return [DefaultInfo(files = depset([output]))]

wasix_aot_payload = rule(
    implementation = _aot_payload_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "target_id": attr.string(mandatory = True),
        "portable": attr.label(mandatory = True),
        "artifacts": attr.label_keyed_string_dict(providers = [WasixAotInfo], mandatory = True),
        "toolchain": attr.label(default = "//src/wasix/runtime:toolchain.toml", allow_single_file = True),
        "_packager": attr.label(default = "//build_defs/wasix:package-aot.mts", allow_single_file = True),
        "_manifest_tool": attr.label(default = "//src/wasix/runtime/tools/xtask:xtask", executable = True, cfg = "exec"),
    },
)

def _wasix_aot_targets(images):
    for target_id in WASIX_AOT_TARGETS:
        prefix = "aot_" + target_id.replace("-", "_") + "_"
        for module, (image, _identity) in images.items():
            wasix_aot(
                name = prefix + module,
                module = ":" + module,
                target_id = target_id,
                output_name = image,
                tags = ["manual"],
                target_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64"],
                exec_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64", "@zig_sdk//libc:gnu.2.34"],
            )
        wasix_aot_payload(
            name = prefix + "payload",
            target_id = target_id,
            portable = ":portable_payload",
            artifacts = {":" + prefix + module: identity for module, (_image, identity) in images.items()},
            tags = ["manual"],
            target_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64"],
        )

def wasix_runtime_aot_targets():
    """Declare the four frozen runtime images for each canonical AOT target."""
    _wasix_aot_targets({
        "postgres": ("oliphaunt-llvm-opta.bin.zst", "runtime:oliphaunt"),
        "initdb": ("initdb-llvm-opta.bin.zst", "tool:initdb"),
        "plpgsql": ("plpgsql-llvm-opta.bin.zst", "runtime-support:plpgsql"),
        "dict_snowball": ("dict_snowball-llvm-opta.bin.zst", "runtime-support:dict_snowball"),
    })

def wasix_tools_aot_targets():
    """Serialize only pg_dump and psql; no core runtime construction edge."""
    _wasix_aot_targets({
        "pg_dump": ("pg_dump-llvm-opta.bin.zst", "tool:pg_dump"),
        "psql": ("psql-llvm-opta.bin.zst", "tool:psql"),
    })
