"""A declared portable runtime tree for source carriers and installed consumers."""

load("//build_defs/foundation:bun-toolchain.bzl", "BUN_TOOLCHAIN_TYPE")
load(":wasm.bzl", "WasmExportPolicyInfo", "WasmModuleInfo")

def postgres_patch_inputs(paths):
    labels = []
    for path in paths:
        matched = False
        for owner in ["src/wasix/runtime", "src/third-party/postgres", "src/native/runtime"]:
            if path.startswith(owner + "/"):
                labels.append("//" + owner + ":" + path[len(owner) + 1:])
                matched = True
                break
        if not matched:
            fail("unsupported PostgreSQL patch owner: " + path)
    return labels

def _payload_impl(ctx):
    runtime = ctx.attr.runtime[WasmModuleInfo].module
    initdb = ctx.attr.initdb[WasmModuleInfo].module
    policy = ctx.attr.export_policy[WasmExportPolicyInfo].exports
    inputs = [runtime, initdb, policy, ctx.file.postgres_source, ctx.file.postgres_series, ctx.file.icu_source]
    entries = [
        {"source": runtime.path, "destination": "bin/postgres", "executable": True},
        {"source": initdb.path, "destination": "bin/initdb", "executable": True},
    ]
    support = []
    trees = []
    for target, name in ctx.attr.support.items():
        file = target[WasmModuleInfo].module
        destination = "lib/postgresql/" + name + ".so"
        inputs.append(file)
        entries.append({"source": file.path, "destination": destination, "executable": True})
        support.append({"name": name, "source": file.path, "path": destination})
    for target, destination in ctx.attr.resources.items():
        for file in target[DefaultInfo].files.to_list():
            inputs.append(file)
            if file.is_directory:
                trees.append(file)
            entries.append({
                "source": file.path,
                "destination": destination + (file.basename if destination.endswith("/") and not file.is_directory else ""),
                "tree": file.is_directory,
            })
    patches = {file.short_path: file.path for file in ctx.files.patches}
    inputs += ctx.files.patches
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode({
        "entries": entries,
        "runtime": runtime.path,
        "initdb": initdb.path,
        "exportPolicy": policy.path,
        "support": support,
        "postgresSource": ctx.file.postgres_source.path,
        "postgresSeries": ctx.file.postgres_series.path,
        "patches": patches,
        "icuSource": ctx.file.icu_source.path,
    }))
    output = ctx.actions.declare_directory(ctx.label.name)
    arguments = ctx.actions.args()
    arguments.add(ctx.file._packager)
    arguments.add("--spec", specification)
    arguments.add("--output", output.path)
    arguments.add("--manifest-tool", ctx.executable._manifest_tool)
    # Bazel expands TreeArtifacts into their declared leaf paths at execution.
    # These leaves are ordinary sandbox projections, not symlink directories
    # that the packager should discover through an ambient recursive walk.
    tree_arguments = ctx.actions.args()
    tree_arguments.add_all(trees, expand_directories = True)
    tree_arguments.use_param_file("--tree-files=%s", use_always = True)
    tree_arguments.set_param_file_format("multiline")
    ctx.actions.run(
        executable = ctx.toolchains[BUN_TOOLCHAIN_TYPE].bun,
        arguments = [arguments, tree_arguments],
        inputs = depset(inputs + [specification, ctx.file._packager] + ctx.files._helpers),
        tools = [ctx.attr._manifest_tool[DefaultInfo].files_to_run],
        outputs = [output],
        env = {"LC_ALL": "C"},
        mnemonic = "WasixRuntimeEnvelope",
        progress_message = "Package declared portable WASIX runtime %{label}",
    )
    return [DefaultInfo(files = depset([output]))]

wasix_runtime_payload = rule(
    implementation = _payload_impl,
    toolchains = [BUN_TOOLCHAIN_TYPE],
    attrs = {
        "runtime": attr.label(providers = [WasmModuleInfo], mandatory = True),
        "initdb": attr.label(providers = [WasmModuleInfo], mandatory = True),
        "export_policy": attr.label(providers = [WasmExportPolicyInfo], mandatory = True),
        "support": attr.label_keyed_string_dict(providers = [WasmModuleInfo], mandatory = True),
        "resources": attr.label_keyed_string_dict(allow_files = True, mandatory = True),
        "patches": attr.label_list(allow_files = [".patch"], mandatory = True),
        "postgres_source": attr.label(default = "//src/third-party/postgres:source.toml", allow_single_file = True),
        "postgres_series": attr.label(default = "//src/wasix/runtime:postgres/series", allow_single_file = True),
        "icu_source": attr.label(default = "//src/third-party/icu:source.toml", allow_single_file = True),
        "_packager": attr.label(default = "//build_defs/wasix:package.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = ["//:tools/packaging/archive-directory.mts", "//:tools/packaging/portable-archive.mts"], allow_files = True),
        "_manifest_tool": attr.label(default = "//src/wasix/runtime/tools/xtask:xtask", executable = True, cfg = "exec"),
    },
)
