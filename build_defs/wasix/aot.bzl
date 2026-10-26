"""Declared LLVM/V8 serialization and original-file imports for canonical targets.

Cross-target construction remains distinct from the required target-host
deserialize, query and reopen consumer proofs.
"""

load("@wasix_tool_metadata//:targets.bzl", "WASIX_AOT_PROFILES", "WASIX_AOT_TARGETS")
load("@wasix_constructor_inputs//:inputs.bzl", "AOT_IMAGES", "PHASE")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")
load("//build_defs/release:shipping.bzl", "shipping_export")
load("//build_defs/release:supplier.bzl", "ShippingSupplierInfo", "merge_shipping_suppliers")
load(":constructor-inputs.bzl", "constructor_source_label", "imported_constructor_supplier", "missing_constructor", "wasix_aot_constructor")
load(":wasm.bzl", "WasmModuleInfo")
load(":platform.bzl", "WASIX_PORTABLE_TRANSITION")

WasixAotInfo = provider(fields = {
    "image": "Zstandard-compressed Wasmer serialized module.",
    "module": "The original portable module.",
    "target": "The exact canonical target triple.",
    "profile": "The target-derived engine and Wasmer/WASIX versions.",
})

def _profile(target_id):
    if target_id not in WASIX_AOT_TARGETS or target_id not in WASIX_AOT_PROFILES:
        fail("WASIX AOT requires an admitted canonical target: " + target_id)
    return WASIX_AOT_PROFILES[target_id]

def _resources(_os, _input_count):
    return {"cpu": 2, "memory": 8192}

def _serialize(ctx, engine):
    profile = _profile(ctx.attr.target_id)
    if profile["engine"] != engine:
        fail("WASIX serializer differs from its target's engine: " + ctx.attr.target_id)
    target = WASIX_AOT_TARGETS[ctx.attr.target_id]
    module = ctx.attr.module[0][WasmModuleInfo].module
    output = ctx.actions.declare_file(ctx.label.name + "/" + ctx.attr.output_name)
    arguments = ctx.actions.args()
    arguments.add_all(["aot-serializer", "serialize"])
    arguments.add("--input", module)
    arguments.add("--output", output)
    arguments.add("--target", target)
    if engine == "llvm-opta":
        arguments.add_all(["--threads", "2"])
    ctx.actions.run(
        executable = ctx.attr._serializer[DefaultInfo].files_to_run,
        arguments = [arguments],
        inputs = [module],
        outputs = [output],
        env = {"LC_ALL": "C"},
        mnemonic = "WasixV8Serialize" if engine == "v8" else "WasixAotSerialize",
        progress_message = "Serialize WASIX AOT " + ctx.attr.target_id + " %{label}",
        resource_set = _resources,
    )
    result = [
        DefaultInfo(files = depset([output])),
        WasixAotInfo(image = output, module = module, target = target, profile = profile),
    ]
    source = ctx.attr.module[0]
    if ShippingSupplierInfo in source:
        result.append(source[ShippingSupplierInfo])
    return result

def _llvm_aot_impl(ctx):
    return _serialize(ctx, "llvm-opta")

def _v8_aot_impl(ctx):
    return _serialize(ctx, "v8")

def _serializer_attrs(serializer):
    return {
        "module": attr.label(providers = [WasmModuleInfo], mandatory = True, cfg = WASIX_PORTABLE_TRANSITION),
        "target_id": attr.string(mandatory = True),
        "output_name": attr.string(mandatory = True),
        "_serializer": attr.label(default = serializer, executable = True, cfg = "exec"),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    }

wasix_llvm_aot = rule(
    implementation = _llvm_aot_impl,
    attrs = _serializer_attrs("//src/wasix/runtime/tools/xtask:aot_serializer"),
)

wasix_v8_aot = rule(
    implementation = _v8_aot_impl,
    attrs = _serializer_attrs("//src/wasix/runtime/tools/v8-serializer:serializer"),
)

def wasix_aot(name, target_id, constructor = True, constructor_owner = None, **kwargs):
    """The engine owns its execution platform; Windows V8 cannot cross-serialize."""
    source = constructor_source_label(":" + name)
    if constructor_owner:
        wasix_aot_constructor(name = name + "_constructor_shipping", image = source,
                              owner = constructor_owner, configuration = target_id, tags = ["manual"])
    record = AOT_IMAGES.get(source) if constructor and PHASE != "source" else None
    common = {key: kwargs[key] for key in ["visibility", "tags", "testonly"] if key in kwargs}
    if record:
        if record["configuration"] != target_id:
            fail("imported WASIX AOT configuration differs from its source declaration: " + source)
        # A regular imported File can be consumed on Linux even when the actual
        # source serializer was constrained to a Windows execution platform.
        wasix_imported_aot(
            name = name, target_id = target_id,
            image = record["file"]["path"], module = kwargs["module"],
            output_name = kwargs["output_name"],
            image_record = json.encode(record),
            **common
        )
        return
    if constructor and (PHASE == "package" or (PHASE == "windows-v8" and _profile(target_id)["engine"] != "v8")):
        missing_constructor(name = name, source = source, kind = "AOT", phase = PHASE, **common)
        return
    if _profile(target_id)["engine"] == "v8":
        kwargs["exec_compatible_with"] = ["@platforms//os:windows", "@platforms//cpu:x86_64"]
        wasix_v8_aot(name = name, target_id = target_id, **kwargs)
    else:
        wasix_llvm_aot(name = name, target_id = target_id, **kwargs)

def _imported_aot_impl(ctx):
    profile = _profile(ctx.attr.target_id)
    source = ctx.attr.module[0]
    image, module = ctx.file.image, source[WasmModuleInfo].module
    if not module.is_source or module.is_directory or not module.short_path.startswith("../"):
        fail("WASIX AOT import requires the original external portable constructor File")
    if image.basename != ctx.attr.output_name:
        fail("imported WASIX AOT filename differs from its source declaration")
    return [
        DefaultInfo(files = depset([image])),
        WasixAotInfo(image = image, module = module, target = WASIX_AOT_TARGETS[ctx.attr.target_id], profile = profile),
        merge_shipping_suppliers([
            imported_constructor_supplier(image, json.decode(ctx.attr.image_record)),
            source[ShippingSupplierInfo],
        ]),
    ]

wasix_imported_aot = rule(
    implementation = _imported_aot_impl,
    attrs = {
        "image": attr.label(allow_single_file = True, mandatory = True),
        "module": attr.label(providers = [WasmModuleInfo, ShippingSupplierInfo], mandatory = True, cfg = WASIX_PORTABLE_TRANSITION),
        "target_id": attr.string(mandatory = True),
        "output_name": attr.string(mandatory = True),
        "image_record": attr.string(mandatory = True),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    },
)

def _aot_payload_impl(ctx):
    profile = _profile(ctx.attr.target_id)
    target = WASIX_AOT_TARGETS[ctx.attr.target_id]
    portable = ctx.attr.portable[DefaultInfo].files.to_list()
    if len(portable) != 1 or not portable[0].is_directory:
        fail("AOT requires the declared portable runtime directory")
    inputs = portable + [ctx.file.toolchain]
    artifacts = []
    for label, name in ctx.attr.artifacts.items():
        artifact = label[WasixAotInfo]
        if artifact.target != target or artifact.profile != profile:
            fail("AOT payload cannot mix serializer targets or engine profiles")
        inputs += [artifact.image, artifact.module]
        artifacts.append({"name": name, "path": artifact.image.basename, "image": artifact.image.path, "module": artifact.module.path})
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({
        "portable_manifest": portable[0].path + "/manifest.json",
        "toolchain": ctx.file.toolchain.path,
        "target_triple": target,
        "profile": profile,
        "engine_sources": ctx.file.engine_sources.path if profile["engine"] == "v8" else None,
        "artifacts": artifacts,
    }))
    if profile["engine"] == "v8":
        inputs.append(ctx.file.engine_sources)
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
    suppliers = [artifact[ShippingSupplierInfo] for artifact in ctx.attr.artifacts if ShippingSupplierInfo in artifact]
    if ShippingSupplierInfo in ctx.attr.portable:
        suppliers.append(ctx.attr.portable[ShippingSupplierInfo])
    return [DefaultInfo(files = depset([output])), merge_shipping_suppliers(suppliers)]

wasix_aot_payload = rule(
    implementation = _aot_payload_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "target_id": attr.string(mandatory = True),
        "portable": attr.label(mandatory = True),
        "artifacts": attr.label_keyed_string_dict(providers = [WasixAotInfo], mandatory = True),
        "toolchain": attr.label(default = "//src/wasix/runtime:toolchain.toml", allow_single_file = True),
        "engine_sources": attr.label(default = "//src/wasix/runtime/engine:sources.json", allow_single_file = True),
        "_packager": attr.label(default = "//build_defs/wasix:package-aot.mts", allow_single_file = True),
        "_manifest_tool": attr.label(default = "//src/wasix/runtime/tools/xtask:xtask", executable = True, cfg = "exec"),
    },
)

def wasix_aot_constructor_exports(name, constructors):
    """Group the actual declarations by their canonical serializer execution domain."""
    for engine, suffix in [("llvm-opta", "llvm"), ("v8", "v8")]:
        shipping_export(name = name + "_" + suffix + "_constructor_export", packages = [
            image + "_constructor_shipping" for target_id, images in constructors.items()
            if _profile(target_id)["engine"] == engine for image in images
        ], tags = ["manual"])

def _wasix_aot_targets(images, owner):
    constructors = {}
    for target_id in WASIX_AOT_TARGETS:
        v8 = _profile(target_id)["engine"] == "v8"
        prefix = "aot_" + target_id.replace("-", "_") + "_"
        constructors[target_id] = []
        for module, (image, _identity) in images.items():
            wasix_aot(
                name = prefix + module,
                module = ":" + module,
                target_id = target_id,
                constructor_owner = owner,
                output_name = image,
                tags = ["manual"],
                target_compatible_with = ["@platforms//os:windows" if v8 else "@platforms//os:linux", "@platforms//cpu:x86_64"],
                exec_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64", "@zig_sdk//libc:gnu.2.34"],
            )
            constructors[target_id].append(":" + prefix + module)
        wasix_aot_payload(
            name = prefix + "payload",
            target_id = target_id,
            portable = ":portable_payload",
            artifacts = {":" + prefix + module: identity for module, (_image, identity) in images.items()},
            tags = ["manual"],
            target_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64"],
        )
    wasix_aot_constructor_exports("aot", constructors)

def wasix_runtime_aot_targets():
    """Declare the four frozen runtime images for each canonical AOT target."""
    _wasix_aot_targets({
        "postgres": ("oliphaunt-llvm-opta.bin.zst", "runtime:oliphaunt"),
        "initdb": ("initdb-llvm-opta.bin.zst", "tool:initdb"),
        "plpgsql": ("plpgsql-llvm-opta.bin.zst", "runtime-support:plpgsql"),
        "dict_snowball": ("dict_snowball-llvm-opta.bin.zst", "runtime-support:dict_snowball"),
    }, "@oliphaunt_metadata//:product_liboliphaunt-wasix")

def wasix_tools_aot_targets():
    """Serialize only pg_dump and psql; no core runtime construction edge."""
    _wasix_aot_targets({
        "pg_dump": ("pg_dump-llvm-opta.bin.zst", "tool:pg_dump"),
        "psql": ("psql-llvm-opta.bin.zst", "tool:psql"),
    }, "@oliphaunt_metadata//:product_postgres-tools-wasix")
