"""Declared lifecycle qualification of the actual native postmaster carrier."""

load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_file_action", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/foundation:bun-sources.bzl", "bun_source_tree")

def _client_configuration(_settings, _attr):
    return {"//command_line_option:platforms": [str(Label("//build_defs/native:linux_x86_64_glibc_2_28"))], "//command_line_option:compilation_mode": "opt"}

_CLIENT_CONFIGURATION = transition(implementation = _client_configuration, inputs = [], outputs = ["//command_line_option:platforms", "//command_line_option:compilation_mode"])

def _runtime_test_impl(ctx):
    client = ctx.attr.psql[0][DefaultInfo]
    psql = client.files_to_run.executable
    libraries = ctx.attr.libpq[0][DefaultInfo].files.to_list()
    if len(libraries) != 1:
        fail("The selected native libpq target must expose one shared library File")
    libpq = libraries[0]
    archive = ctx.actions.declare_file(ctx.label.name + ".carrier.tar.gz")
    leaves = ctx.actions.args()
    leaves.add_all([ctx.file.carrier], expand_directories = True)
    leaves.use_param_file("--tree-files=%s", use_always = True)
    leaves.set_param_file_format("multiline")
    # Preserve the strict installed-tree reader: Bazel presents TreeArtifact
    # runfiles as per-leaf symlinks, so transport the declared bytes as an archive.
    bun_file_action(
        ctx,
        ctx.file._archive_driver,
        source_files = [ctx.file._archive_driver, ctx.file._archiver, ctx.file._portable_archive],
        sources = bun_source_tree(ctx, ctx.label.name + ".archive-sources", [ctx.file._archive_driver, ctx.file._archiver, ctx.file._portable_archive]),
        arguments = [ctx.file.carrier.path, archive.path, leaves],
        inputs = [ctx.file.carrier],
        outputs = [archive],
        mnemonic = "PostmasterTestArchive",
    )
    return bun_test_entrypoint(
        ctx,
        runner = ctx.file._runner,
        arguments = ["--archive", archive, psql, libpq],
        files = [archive, psql, libpq] + ctx.files._sources,
        source_files = [ctx.file._runner] + ctx.files._sources,
        additional_runfiles = client.default_runfiles,
    )

_postmaster_runtime_test = rule(
    implementation = _runtime_test_impl,
    test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "carrier": attr.label(mandatory = True, allow_single_file = True),
        "psql": attr.label(default = "@postgres//:psql", cfg = _CLIENT_CONFIGURATION),
        "libpq": attr.label(default = "@postgres//:libpq_shared", cfg = _CLIENT_CONFIGURATION),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
        "_runner": attr.label(default = "//build_defs/wasix/postmaster:runtime-test.mts", allow_single_file = True),
        "_archiver": attr.label(default = "//:tools/packaging/archive-directory.mts", allow_single_file = True),
        "_archive_driver": attr.label(default = "//build_defs/wasix/postmaster:test-archive.mts", allow_single_file = True),
        "_portable_archive": attr.label(default = "//:tools/packaging/portable-archive.mts", allow_single_file = True),
        "_sources": attr.label_list(default = [
            "//:tools/packaging/portable-archive.mts",
            "//build_defs/wasix/postmaster:native-receipts.mts",
            "//:tools/packaging/strict-json.mts",
            "//src/wasix/postmaster:lib/verify-sealed-carrier.mts",
            "//src/wasix/postmaster:lib/guest-build-provenance.mts",
            "//src/wasix/postmaster:lib/receipt-files.mts",
            "//src/wasix/postmaster:lib/linear-memory-profile.mts",
            "//src/wasix/postmaster:lib/sealed-export-chain.mts",
            "//src/wasix/postmaster:wasmer/bin/verify-postmaster-concurrency-contract.mts",
            "//src/wasix/postmaster:wasmer/bin/verify-postmaster-wasm-import.mts",
            "//src/wasix/postmaster:wasmer/policies/sealed-main-runtime-exports.v1.txt",
            "//src/wasix/postmaster:wasmer/policies/sealed-main-dlsym-exports.v1.txt",
            "//src/wasix/postmaster:wasmer/policies/sealed-side-modules.v1.tsv",
        ], allow_files = True),
    }),
)

def postmaster_runtime_test(name, **kwargs):
    _postmaster_runtime_test(name = name, args = bun_test_entrypoint_args(name), **kwargs)
