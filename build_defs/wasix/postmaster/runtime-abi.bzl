"""Bind the native serialized protocol to actual configured Rust dependencies."""

load("@rules_rust//rust:defs.bzl", "rust_common")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")

_FeaturesInfo = provider(fields = ["crates"])
_RUST_TOOLCHAIN = "@rules_rust//rust:toolchain_type"

def _features_impl(target, ctx):
    transitive = []
    for dep in getattr(ctx.rule.attr, "deps", []):
        if _FeaturesInfo in dep:
            transitive.append(dep[_FeaturesInfo].crates)
    direct = []
    if rust_common.crate_info in target:
        crate = target[rust_common.crate_info]
        if crate.type == "rlib":
            direct.append(struct(
                crate_name = crate.name,
                version = ctx.rule.attr.version,
                target = ctx.toolchains[_RUST_TOOLCHAIN].target_triple.str,
                features = tuple(ctx.rule.attr.crate_features),
            ))
    return [_FeaturesInfo(crates = depset(direct, transitive = transitive))]

_features = aspect(
    implementation = _features_impl,
    attr_aspects = ["deps"],
    toolchains = [_RUST_TOOLCHAIN],
)

def _role_features(dependencies):
    return [
        {"crate_name": row.crate_name, "version": row.version, "target": row.target, "features": list(row.features)}
        for row in depset(transitive = [dep[_FeaturesInfo].crates for dep in dependencies]).to_list()
    ]

def _runtime_abi_impl(ctx):
    rust = ctx.toolchains[_RUST_TOOLCHAIN]
    patches = {}
    for patch in ctx.files.patches:
        if patch.basename in patches:
            fail("Duplicate declared postmaster patch basename: " + patch.basename)
        patches[patch.basename] = patch.path
    root_sources = {}
    for source in ctx.files.root_sources:
        prefix = ctx.label.package + "/executor/"
        if not source.short_path.startswith(prefix):
            fail("Expected declared canonical executor source: " + source.short_path)
        relative = source.short_path.removeprefix(prefix)
        if relative in root_sources:
            fail("Duplicate canonical executor source: " + relative)
        root_sources[relative] = source.path
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({
        "manifest": ctx.file.manifest.path,
        "lock": ctx.file.lock.path,
        "contexts": {"executor": ctx.file.executor_context.path, "compiler": ctx.file.compiler_context.path},
        "sources": ctx.file.sources.path,
        "sourceIdentity": ctx.file.source_identity.path,
        "serializer": ctx.file.serializer.path,
        "loader": ctx.file.loader.path,
        "patches": patches,
        "rootSources": root_sources,
        "rust": {"target": rust.target_triple.str, "version": rust.version, "flags": rust.extra_rustc_flags, "exec_flags": rust.extra_exec_rustc_flags, "compilation_mode": ctx.var["COMPILATION_MODE"]},
        "rustc": rust.rustc.path,
        "roles": {"executor": _role_features(ctx.attr.executor_deps), "compiler": _role_features(ctx.attr.compiler_deps)},
    }))
    contract = ctx.actions.declare_file(ctx.label.name + ".json")
    environment = ctx.actions.declare_file(ctx.label.name + ".env")
    arguments = ctx.actions.args()
    arguments.add_all([spec, contract, environment])
    bun_file_action(
        ctx,
        ctx.file._writer,
        arguments = [arguments],
        inputs = [spec, rust.rustc, ctx.file.manifest, ctx.file.lock, ctx.file.executor_context, ctx.file.compiler_context, ctx.file.sources, ctx.file.source_identity, ctx.file.serializer, ctx.file.loader] + ctx.files.patches + ctx.files.root_sources,
        source_files = [ctx.file._compile_metadata],
        outputs = [contract, environment],
        mnemonic = "PostmasterNativeRuntimeAbi",
        progress_message = "Bind configured native postmaster serialization ABI %{label}",
    )
    return [DefaultInfo(files = depset([environment])), OutputGroupInfo(contract = depset([contract]))]

postmaster_runtime_abi = rule(
    implementation = _runtime_abi_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS + [_RUST_TOOLCHAIN],
    attrs = {
        "executor_deps": attr.label_list(mandatory = True, aspects = [_features]),
        "compiler_deps": attr.label_list(mandatory = True, aspects = [_features]),
        "patches": attr.label_list(allow_files = True),
        "root_sources": attr.label_list(allow_files = [".rs"], mandatory = True),
        "manifest": attr.label(default = "//src/wasix/postmaster:executor/Cargo.toml", allow_single_file = True),
        "lock": attr.label(default = "//src/wasix/postmaster:executor/Cargo.lock", allow_single_file = True),
        "executor_context": attr.label(default = "@postmaster_executor_crates//:cargo-bazel.json", allow_single_file = True),
        "compiler_context": attr.label(default = "@postmaster_compiler_crates//:cargo-bazel.json", allow_single_file = True),
        "sources": attr.label(default = "@postmaster_cargo//:cargo-sources.json", allow_single_file = True),
        "source_identity": attr.label(default = "@postmaster_wasmer//:source.json", allow_single_file = True),
        "serializer": attr.label(default = "@postmaster_wasmer//:lib/types/src/serialize.rs", allow_single_file = True),
        "loader": attr.label(default = "//src/wasix/postmaster:executor/src/sealed.rs", allow_single_file = True),
        "_writer": attr.label(default = "//build_defs/wasix/postmaster:runtime-abi.mts", allow_single_file = True),
        "_compile_metadata": attr.label(default = "//build_defs/wasix/postmaster:compile-metadata.mts", allow_single_file = True),
    },
)
