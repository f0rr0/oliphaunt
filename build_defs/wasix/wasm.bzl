"""Declared WASIX relocatable, side-module, sealed-link and optimization actions."""

load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")
load("@wasix_constructor_inputs//:inputs.bzl", "MODULES", "PHASE")
load("//build_defs/release:supplier.bzl", "ShippingSupplierInfo")
load(":constructor-inputs.bzl", "constructor_source_label", "imported_constructor_supplier", "missing_constructor", "wasix_module_constructor")

WasmModuleInfo = provider(fields = {
    "module": "The optimized portable module.",
    "archives": "Static archives owned by this module and its dynamic dependencies.",
})
WasmExportPolicyInfo = provider(fields = {"exports": "Sorted LF export list.", "response": "Linker export response file."})

def _link_resources(_os, _input_count):
    return {"cpu": 2, "memory": 2048}

def _archives(dependencies):
    archives = {}
    for dependency in dependencies:
        for linker_input in dependency[CcInfo].linking_context.linker_inputs.to_list():
            if linker_input.user_link_flags or linker_input.additional_inputs:
                fail("WASIX static archive link needs explicit handling of CcInfo flags/additional inputs from " + str(linker_input.owner))
            for library in linker_input.libraries:
                archive = library.pic_static_library or library.static_library
                if not archive:
                    fail("WASIX module requires a static CcInfo library: " + str(dependency.label))
                archives[archive.path] = archive
    return archives.values()

def _objects(dependencies):
    objects = []
    for dependency in dependencies:
        owned = []
        for linker_input in dependency[CcInfo].linking_context.linker_inputs.to_list():
            if linker_input.owner != dependency.label:
                continue
            if linker_input.user_link_flags or linker_input.additional_inputs:
                fail("WASIX direct objects require explicit CcInfo flags/additional inputs from " + str(dependency.label))
            for library in linker_input.libraries:
                owned.extend(library.pic_objects or library.objects)
        if not owned:
            fail("WASIX direct objects require the maintained compilation outputs owned by " + str(dependency.label))
        objects.extend(owned)
    if len({file.path: True for file in objects}) != len(objects):
        fail("WASIX direct object ownership overlaps")
    return objects

def _relocatable_impl(ctx):
    archives = _archives(ctx.attr.deps)
    output = ctx.actions.declare_file(ctx.label.name + ".o")
    arguments = ctx.actions.args()
    arguments.add("-r")
    arguments.add("--threads=2")
    # Canonical PG patch0022 lowers ThinLTO here, before the final sealed link.
    # Prevent inlining from hiding sigsetjmp from WASIX exception lowering.
    arguments.add_all([
        "-mllvm", "-inline-threshold=0",
        "-mllvm", "--wasm-enable-eh", "-mllvm", "--wasm-enable-sjlj",
        "-mllvm", "--wasm-use-legacy-eh=false", "-mllvm", "--exception-model=wasm",
    ])
    arguments.add("--whole-archive")
    arguments.add_all(archives)
    arguments.add("--no-whole-archive")
    arguments.add("-o", output)
    ctx.actions.run(
        executable = ctx.executable._linker,
        arguments = [arguments],
        inputs = depset(archives),
        tools = ctx.files._linker_files,
        outputs = [output],
        env = {"LC_ALL": "C"},
        mnemonic = "WasixRelocatableLink",
        progress_message = "Combine WASIX backend objects %{label}",
        resource_set = _link_resources,
    )
    return [DefaultInfo(files = depset([output]))]

wasix_relocatable = rule(
    implementation = _relocatable_impl,
    attrs = {
        "deps": attr.label_list(providers = [CcInfo], mandatory = True),
        "_linker": attr.label(default = "@wasix_toolchain//:llvm/bin/wasm-ld", executable = True, allow_single_file = True, cfg = "exec"),
        "_linker_files": attr.label(default = "@wasix_toolchain//:llvm_files", cfg = "exec"),
    },
)

def _policy_impl(ctx):
    modules = [dependency[WasmModuleInfo].module for dependency in ctx.attr.modules]
    exports = ctx.actions.declare_file(ctx.label.name + ".exports")
    response = ctx.actions.declare_file(ctx.label.name + ".rsp")
    arguments = ctx.actions.args()
    arguments.add_all(["assets", "export-policy"])
    for module in modules:
        arguments.add("--module")
        arguments.add(module.basename + "=" + module.path)
    arguments.add("--output", exports)
    arguments.add("--response", response)
    ctx.actions.run(
        executable = ctx.executable._analyzer,
        arguments = [arguments],
        inputs = depset(modules),
        outputs = [exports, response],
        env = {"LC_ALL": "C"},
        mnemonic = "WasixExportPolicy",
        progress_message = "Derive sealed WASIX exports %{label}",
    )
    return [DefaultInfo(files = depset([exports, response])), WasmExportPolicyInfo(exports = exports, response = response)]

wasix_export_policy = rule(
    implementation = _policy_impl,
    attrs = {
        "modules": attr.label_list(providers = [WasmModuleInfo], mandatory = True),
        "_analyzer": attr.label(default = "//src/wasix/runtime/tools/xtask:xtask", executable = True, cfg = "exec"),
    },
)

def _module_impl(ctx):
    objects = ctx.files.srcs + _objects(ctx.attr.object_deps)
    whole_archives = _archives(ctx.attr.deps)
    lazy_archives = _archives(ctx.attr.archive_deps)
    whole_paths = {archive.path: True for archive in whole_archives}
    for archive in lazy_archives:
        if archive.path in whole_paths:
            fail("WASIX whole and lazy archive ownership overlap: " + archive.path)
    dynamic_modules = [dependency[WasmModuleInfo] for dependency in ctx.attr.dynamic_deps]
    dynamic_archives = {}
    for dependency in dynamic_modules:
        for archive in dependency.archives.to_list():
            if archive.path in dynamic_archives:
                fail("WASIX dynamic dependencies have overlapping archive ownership: " + archive.path)
            dynamic_archives[archive.path] = True
    whole_archives = [archive for archive in whole_archives if archive.path not in dynamic_archives]
    lazy_archives = [archive for archive in lazy_archives if archive.path not in dynamic_archives]
    archives = whole_archives + lazy_archives
    raw = ctx.actions.declare_file(ctx.label.name + "/" + ctx.attr.output_name + ".unoptimized")
    output = ctx.actions.declare_file(ctx.label.name + "/" + ctx.attr.output_name)
    # These flags are the pinned wasixcc dynamic-linking ABI. Invoke its LLVM
    # linker directly so optimization and sealed export selection are actions.
    root = ctx.executable._linker.dirname[:-len("/llvm/bin")]
    sysroot = ctx.file.constructed_sysroot.path if ctx.attr.constructed_sysroot else root + "/sysroot/sysroot-exnref-ehpic"
    if ctx.attr.constructed_sysroot and not ctx.file.constructed_sysroot.is_directory:
        fail("WASIX constructed_sysroot must be the declared source-built sysroot tree")
    arguments = ctx.actions.args()
    arguments.add_all([
        "--threads=2",
        "--no-entry",
        "--extra-features=atomics,bulk-memory,mutable-globals",
        "--shared-memory", "--max-memory=4294967296", "--import-memory",
        "--export=__wasm_call_ctors", "--no-demangle",
        "-mllvm", "--wasm-enable-eh", "-mllvm", "--wasm-enable-sjlj",
        "-mllvm", "--wasm-use-legacy-eh=false", "-mllvm", "--exception-model=wasm",
        "--export=__wasm_init_tls", "--export=__wasm_signal",
        "--export=__tls_size", "--export=__tls_align", "--export=__tls_base",
        "--export-if-defined=__indirect_function_table",
        "--experimental-pic", "--export-if-defined=__wasm_apply_data_relocs",
        "--export-if-defined=__wasm_apply_tls_relocs",
        "-L" + sysroot + "/lib", "-L" + sysroot + "/lib/wasm32-wasi",
    ])
    inputs = archives + objects + [dependency.module for dependency in dynamic_modules]
    if ctx.attr.constructed_sysroot:
        inputs.append(ctx.file.constructed_sysroot)
    is_command = bool(ctx.attr.export_policy) or ctx.attr.kind == "command"
    if is_command and (ctx.attr.cxx_runtime or dynamic_modules):
        fail("WASIX cxx_runtime/dynamic_deps apply only to side modules")
    if is_command:
        arguments.add_all([
            "--export-if-defined=__stack_pointer", "--export-if-defined=__heap_base",
            "--export-if-defined=__data_end", "-pie",
            "--whole-archive", "-lwasi-emulated-getpid", "-lwasi-emulated-mman",
            "-lwasi-emulated-process-clocks", "-lc", "-lresolv", "-lrt", "-lm",
            "-lpthread", "-lutil", "--no-whole-archive", "-lclang_rt.builtins-wasm32",
            "-lcommon-tag-stubs",
        ])
        if ctx.attr.export_policy:
            policy = ctx.attr.export_policy[WasmExportPolicyInfo]
            arguments.add("@" + policy.response.path)
            inputs.append(policy.response)
        else:
            arguments.add("--export=_start")
        arguments.add_all(objects)
        arguments.add_all(whole_archives)
        arguments.add_all(lazy_archives)
        arguments.add_all([sysroot + "/lib/wasm32-wasi/" + library for library in ["libc++.a", "libc++abi.a", "libunwind.a", "crt1.o"]])
    else:
        arguments.add_all(["-shared", "--unresolved-symbols=import-dynamic", "--export-dynamic", "--soname=" + ctx.attr.output_name])
        arguments.add("--whole-archive")
        arguments.add_all(objects)
        arguments.add_all(whole_archives)
        if ctx.attr.cxx_runtime:
            arguments.add_all([sysroot + "/lib/wasm32-wasi/" + library for library in ["libc++.a", "libc++abi.a", "libunwind.a"]])
        arguments.add("--no-whole-archive")
        arguments.add_all(lazy_archives)
        if ctx.attr.cxx_runtime:
            arguments.add_all(["-lm", "-lc"])
        if dynamic_modules:
            arguments.add("--Bdynamic")
            arguments.add_all([dependency.module for dependency in dynamic_modules])
            arguments.add_all(["-rpath", "$ORIGIN"])
        arguments.add("-lclang_rt.builtins-wasm32")
        arguments.add(sysroot + "/lib/wasm32-wasi/scrt1.o")
    arguments.add_all(ctx.attr.linkopts)
    arguments.add("-o", raw)
    ctx.actions.run(
        executable = ctx.executable._linker,
        arguments = [arguments],
        inputs = depset(inputs),
        tools = ctx.files._llvm_files if ctx.attr.constructed_sysroot else ctx.files._linker_files,
        outputs = [raw],
        env = {"LC_ALL": "C"},
        mnemonic = "WasixSealedLink" if is_command else "WasixSideLink",
        progress_message = "Link portable WASIX module %{label}",
        resource_set = _link_resources,
    )
    optimize = ctx.actions.args()
    optimize.add(raw)
    optimize.add_all(ctx.attr.optimization_flags)
    optimize.add("-o", output)
    ctx.actions.run(
        executable = ctx.executable._optimizer,
        arguments = [optimize],
        inputs = [raw],
        tools = ctx.files._optimizer_files,
        outputs = [output],
        env = {"LC_ALL": "C", "BINARYEN_CORES": "2"},
        mnemonic = "WasixOptimize",
        progress_message = "Optimize portable WASIX module %{label}",
        resource_set = _link_resources,
    )
    return [
        DefaultInfo(files = depset([output])),
        WasmModuleInfo(module = output, archives = depset(archives, transitive = [dependency.archives for dependency in dynamic_modules])),
        ShippingSupplierInfo(suppliers = [], files = depset()),
        OutputGroupInfo(unoptimized = depset([raw])),
    ]

_wasix_module = rule(
    implementation = _module_impl,
    attrs = {
        "output_name": attr.string(mandatory = True),
        "kind": attr.string(default = "side", values = ["side", "command"]),
        "deps": attr.label_list(providers = [CcInfo]),
        "object_deps": attr.label_list(providers = [CcInfo]),
        "archive_deps": attr.label_list(providers = [CcInfo]),
        "dynamic_deps": attr.label_list(providers = [WasmModuleInfo]),
        "cxx_runtime": attr.bool(default = False),
        "srcs": attr.label_list(allow_files = [".o"]),
        "export_policy": attr.label(providers = [WasmExportPolicyInfo]),
        "linkopts": attr.string_list(),
        "constructed_sysroot": attr.label(allow_single_file = True, providers = [CcInfo]),
        "optimization_flags": attr.string_list(default = ["-O2", "--enable-threads", "--enable-mutable-globals", "--enable-bulk-memory", "--enable-bulk-memory-opt", "--enable-exception-handling", "--enable-simd", "--enable-relaxed-simd", "--enable-extended-const", "--emit-exnref", "--converge", "--strip-debug", "--strip-producers"]),
        "_linker": attr.label(default = "@wasix_toolchain//:llvm/bin/wasm-ld", executable = True, allow_single_file = True, cfg = "exec"),
        "_linker_files": attr.label(default = "@wasix_toolchain//:linker_files", cfg = "exec"),
        "_llvm_files": attr.label(default = "@wasix_toolchain//:llvm_files", cfg = "exec"),
        "_optimizer": attr.label(default = "@wasix_toolchain//:binaryen/bin/wasm-opt", executable = True, allow_single_file = True, cfg = "exec"),
        "_optimizer_files": attr.label(default = "@wasix_toolchain//:binaryen_files", cfg = "exec"),
    },
)

def _imported_module_impl(ctx):
    module = ctx.file.module
    if module.basename != ctx.attr.output_name:
        fail("imported WASIX module filename differs from its source declaration")
    return [
        DefaultInfo(files = depset([module])),
        WasmModuleInfo(module = module, archives = depset()),
        imported_constructor_supplier(module, json.decode(ctx.attr.record)),
    ]

_imported_module = rule(
    implementation = _imported_module_impl,
    attrs = {
        "module": attr.label(allow_single_file = True, mandatory = True),
        "output_name": attr.string(mandatory = True),
        "record": attr.string(mandatory = True),
    },
)

def wasix_module(name, constructor = True, constructor_owner = None, **kwargs):
    """Import the exact original portable File in foreign/final constructor phases."""
    if constructor_owner:
        wasix_module_constructor(
            name = name + "_constructor_shipping",
            module = "//" + native.package_name() + ":" + name,
            owner = constructor_owner,
            tags = ["manual"],
        )
    if not constructor or PHASE == "source":
        _wasix_module(name = name, **kwargs)
        return
    source = constructor_source_label(":" + name)
    record = MODULES.get(source)
    common = {key: kwargs[key] for key in ["visibility", "tags", "testonly", "target_compatible_with"] if key in kwargs}
    if not record:
        missing_constructor(name = name, source = source, kind = "portable", phase = PHASE, **common)
        return
    _imported_module(
        name = name,
        module = record["file"]["path"],
        output_name = kwargs["output_name"],
        record = json.encode(record),
        **common
    )
