"""Exercise real Rust compile actions without executing a foreign compiler."""

load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts")
load("@rules_rust//rust:defs.bzl", "rust_common")
load("@rules_rust//rust/platform:triple.bzl", "triple")

# buildifier: disable=bzl-visibility
load("@rules_rust//rust/private:rustc.bzl", "rustc_compile_action")

_FixtureInfo = provider(fields = ["archives", "metadata", "dll", "uses_metadata"])
_DEPENDENCIES = 400

def _fixture_impl(ctx):
    real_toolchain = ctx.toolchains["@rules_rust//rust:toolchain_type"]
    fields = {name: getattr(real_toolchain, name) for name in dir(real_toolchain)}
    fields["exec_triple"] = triple("x86_64-pc-windows-msvc" if ctx.attr.windows_host else "x86_64-unknown-linux-gnu")
    # A Windows target on a Linux compiler host must keep the ordinary search paths.
    if not ctx.attr.windows_host:
        fields["target_os"] = "windows"
    toolchain = struct(**fields)

    empty_dep_info = rust_common.dep_info(**{
        name: depset([])
        for name in [
            "direct_crates", "transitive_crates", "transitive_data", "transitive_proc_macro_data",
            "transitive_noncrates", "transitive_crate_outputs", "transitive_metadata_outputs",
            "transitive_build_infos", "link_search_path_files",
        ]
    } | {"dep_env": None})
    archives, metadata, deps = [], [], []
    for index in range(_DEPENDENCIES):
        directory = ctx.label.name + "/search/" + str(index) + "/" + "long_dependency_directory_" * 4
        # Identical names in different directories model configured crate variants.
        stem = "libcollision-123" if index < 2 else "libdep_" + str(index) + "-123"
        archive = ctx.actions.declare_file(directory + "/" + stem + ".rlib")
        meta = ctx.actions.declare_file(directory + "/" + stem + ".rmeta")
        ctx.actions.write(archive, "archive " + str(index))
        ctx.actions.write(meta, "metadata " + str(index))
        archives.append(archive)
        metadata.append(meta)
        crate = rust_common.create_crate_info(
            name = "dep_" + str(index), type = "rlib", output = archive,
            metadata = meta, metadata_supports_pipelining = index != 2,
            owner = ctx.label, rustc_env_files = (),
        )
        deps.append(rust_common.dep_variant_info(crate_info = crate, dep_info = empty_dep_info, cc_info = None, build_info = None))

    dll = ctx.actions.declare_file(ctx.label.name + "/macro/fixture_macro.dll")
    ctx.actions.write(dll, "proc-macro fixture")
    macro = rust_common.create_crate_info(name = "fixture_macro", type = "proc-macro", output = dll, owner = ctx.label, rustc_env_files = ())
    output = ctx.actions.declare_file("lib" + ctx.label.name + (".rlib" if ctx.attr.kind == "rlib" else ".so"))
    uses_metadata = ctx.attr.kind == "rlib"
    providers = rustc_compile_action(
        ctx = ctx, attr = ctx.attr, toolchain = toolchain,
        crate_info_dict = dict(
            name = ctx.label.name, type = ctx.attr.kind, root = ctx.file.source, srcs = [ctx.file.source],
            deps = deps,
            proc_macro_deps = [rust_common.dep_variant_info(crate_info = macro, dep_info = empty_dep_info, cc_info = None, build_info = None)],
            aliases = {}, output = output,
            metadata = ctx.actions.declare_file("lib" + ctx.label.name + ".rmeta") if uses_metadata else None,
            metadata_supports_pipelining = uses_metadata,
            owner = ctx.label, edition = "2021", is_test = False,
            compile_data = depset([]), compile_data_targets = depset([]), rustc_env = {},
        ),
    )
    return providers + [_FixtureInfo(archives = archives, metadata = metadata, dll = dll, uses_metadata = uses_metadata)]

_fixture = rule(
    implementation = _fixture_impl,
    attrs = {
        "windows_host": attr.bool(default = True),
        "kind": attr.string(default = "rlib"),
        "source": attr.label(default = ":rust-dependency-paths-fixture.rs", allow_single_file = True),
        "_always_enable_metadata_output_groups": attr.label(default = "@rules_rust//rust/settings:always_enable_metadata_output_groups"),
        "_error_format": attr.label(default = "@rules_rust//rust/settings:error_format"),
        "_process_wrapper": attr.label(default = "@rules_rust//util/process_wrapper", executable = True, cfg = "exec"),
    },
    toolchains = ["@rules_rust//rust:toolchain_type", config_common.toolchain_type("@bazel_tools//tools/cpp:toolchain_type", mandatory = False)],
    fragments = ["cpp"],
)

def _paths_impl(ctx):
    env = analysistest.begin(ctx)
    target = analysistest.target_under_test(env)
    fixture = target[_FixtureInfo]
    original_dirs = [file.dirname for file in fixture.archives] + [fixture.dll.dirname]
    asserts.true(env, len(";".join(original_dirs)) > 32767, "fixture must exceed the Windows PATH limit")
    actions = analysistest.target_actions(env)
    aliases = [action for action in actions if action.mnemonic == "Symlink" and "/_rust_deps/" in action.outputs.to_list()[0].path]
    rust_actions = [action for action in actions if action.mnemonic in ["Rustc", "RustcMetadata"]]
    asserts.equals(env, 2 if fixture.uses_metadata else 1, len(rust_actions))
    expected = [meta if fixture.uses_metadata and index != 2 else fixture.archives[index] for index, meta in enumerate(fixture.metadata)]
    if ctx.attr.consolidated:
        asserts.equals(env, _DEPENDENCIES, len(aliases))
        alias_files = [action.outputs.to_list()[0] for action in aliases]
        asserts.equals(env, _DEPENDENCIES, len({file.basename: True for file in alias_files}), "same-basename crate variants must survive")
        asserts.equals(env, sorted([file.path for file in expected]), sorted([action.inputs.to_list()[0].path for action in aliases]))
        expected_dirs = {file.dirname: True for file in alias_files} | {fixture.dll.dirname: True}
        asserts.equals(env, 2, len(expected_dirs))
        asserts.true(env, len(";".join(expected_dirs.keys())) < 32767)
    else:
        asserts.equals(env, 0, len(aliases), "a Windows target alone must not consolidate compiler search paths")
        alias_files = []
        expected_dirs = {directory: True for directory in original_dirs}

    for action in rust_actions:
        actual_dirs = [arg.removeprefix("-Ldependency=") for arg in action.argv if arg.startswith("-Ldependency=")]
        asserts.equals(env, sorted(expected_dirs.keys()), sorted(actual_dirs))
        inputs = action.inputs.to_list()
        for file in alias_files + [fixture.dll]:
            asserts.true(env, file in inputs, "search artifacts must be declared Rust inputs: " + file.path)
        asserts.true(env, "--extern=dep_0=" + expected[0].path in action.argv, "direct dependency identities must remain unchanged")
        asserts.true(env, "--extern=fixture_macro=" + fixture.dll.path in action.argv)
        if fixture.uses_metadata:
            asserts.false(env, fixture.archives[0] in inputs, "metadata consumers must not wait for full archives")
            asserts.true(env, fixture.archives[2] in inputs, "non-pipelined dependencies still require full archives")
    return analysistest.end(env)

_paths_test = analysistest.make(_paths_impl, attrs = {"consolidated": attr.bool(default = True)})

def rust_dependency_paths_tests():
    tests = []
    for name, kind, windows_host in [
        ("windows_rust_metadata_paths", "rlib", True),
        ("windows_rust_link_paths", "cdylib", True),
        ("nonwindows_rust_paths", "rlib", False),
    ]:
        _fixture(name = name + "_fixture", kind = kind, windows_host = windows_host, tags = ["manual"])
        _paths_test(name = name + "_test", target_under_test = ":" + name + "_fixture", consolidated = windows_host, size = "small")
        tests.append(":" + name + "_test")
    native.test_suite(name = "rust_dependency_paths_tests", tests = tests)
