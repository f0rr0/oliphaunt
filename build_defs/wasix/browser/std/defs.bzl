"""Native per-crate construction of the browser's atomics-enabled Rust sysroot."""

load("@rules_rust//rust:defs.bzl", "rust_binary")
load("@rules_rust//rust:toolchain.bzl", "rust_stdlib_filegroup", "rust_toolchain")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")

_StdCrateInfo = provider(fields = ["output", "closure"])
_StdBuildInfo = provider(fields = ["flags", "environment", "out_dir"])

def _script_impl(ctx):
    flags = ctx.actions.declare_file(ctx.label.name + ".flags")
    environment = ctx.actions.declare_file(ctx.label.name + ".env")
    out_dir = ctx.actions.declare_directory(ctx.label.name + ".out")
    source_root = ctx.file.manifest.dirname
    bun_file_action(
        ctx,
        ctx.file._runner,
        arguments = [ctx.executable.binary.path, source_root, out_dir.path, flags.path, environment.path, ctx.file.compiler.path],
        inputs = depset([ctx.file.manifest, ctx.file.compiler] + ctx.files.srcs + ctx.files.compiler_files),
        source_files = [],
        tools = [ctx.attr.binary[DefaultInfo].files_to_run],
        outputs = [flags, environment, out_dir],
        env = ctx.attr.environment,
        mnemonic = "BrowserStdBuildScript",
        progress_message = "Running native browser std configuration %{label}",
    )
    return [DefaultInfo(files = depset([flags, environment, out_dir])), _StdBuildInfo(flags = flags, environment = environment, out_dir = out_dir)]

_script = rule(
    implementation = _script_impl,
    attrs = {
        "binary": attr.label(executable = True, cfg = "exec", mandatory = True),
        "manifest": attr.label(allow_single_file = True, mandatory = True),
        "srcs": attr.label_list(allow_files = True),
        "compiler": attr.label(allow_single_file = True, mandatory = True),
        "compiler_files": attr.label_list(allow_files = True),
        "environment": attr.string_dict(),
        "_runner": attr.label(default = Label("//build_defs/wasix/browser/std:build-script.mts"), allow_single_file = True),
    },
    toolchains = BUN_SOURCE_TOOLCHAINS,
)

def _crate_impl(ctx):
    output = ctx.actions.declare_file("lib/rustlib/wasm32-unknown-unknown/lib/lib" + ctx.attr.crate_name + ".rlib")
    empty = ctx.actions.declare_file(ctx.label.name + ".empty-sysroot/anchor")
    ctx.actions.write(empty, "")
    arguments = ctx.actions.args()
    for name in ["pwd", "exec_root", "output_base"]:
        arguments.add_all(["--subst", name + "=${" + name + "}"])
    if ctx.attr.build_script:
        script = ctx.attr.build_script[_StdBuildInfo]
        arguments.add("--env-file", script.environment)
        arguments.add("--arg-file", script.flags)
        arguments.add("--out-dir", script.out_dir.path)
    arguments.add("--")
    arguments.add(ctx.file.compiler)
    arguments.add(ctx.file.crate_root)
    arguments.add_all(["--crate-name", ctx.attr.crate_name, "--crate-type", "rlib", "--edition", ctx.attr.edition, "--target", "wasm32-unknown-unknown", "--sysroot", empty.dirname, "--emit=link", "--cap-lints=allow", "-Zforce-unstable-if-unmarked", "-Copt-level=" + str(ctx.attr.opt_level), "-Clto=fat", "-Clinker-plugin-lto", "-Cmetadata=oliphaunt-browser-std-" + ctx.attr.crate_name + "-" + ctx.attr.version, "-o", output.path])
    # Match rules_rust's execution-path remapping, then give this pinned
    # source repository a namespace independent of its generated repo name.
    # Rust applies the most specific (last) matching prefix first.
    for root in ["${output_base}", "${pwd}", "${exec_root}"]:
        arguments.add("--remap-path-prefix=" + root + "=.")
    for root in ["${output_base}/", "${pwd}/", "${exec_root}/", ""]:
        arguments.add("--remap-path-prefix=" + root + ctx.label.workspace_root + "=/oliphaunt/browser-rust-std")
    arguments.add_all(ctx.attr.flags)
    if ctx.attr.codegen_units:
        arguments.add("-Ccodegen-units=" + str(ctx.attr.codegen_units))
    for feature in ctx.attr.crate_features:
        arguments.add_all(["--cfg", 'feature="' + feature + '"'])
    dependencies = []
    for target, name in ctx.attr.deps.items():
        info = target[_StdCrateInfo]
        arguments.add_all(["--extern", name + "=" + info.output.path])
        dependencies.append(info.closure)
    closure = depset(transitive = dependencies)
    for directory in sorted({file.dirname: True for file in closure.to_list()}.keys()):
        arguments.add_all(["-L", "dependency=" + directory])
    ctx.actions.run(
        executable = ctx.executable._wrapper,
        arguments = [arguments],
        inputs = depset([empty, ctx.file.crate_root, ctx.file.compiler] + ctx.files.srcs + ctx.files.compiler_files, transitive = dependencies + ([ctx.attr.build_script[DefaultInfo].files] if ctx.attr.build_script else [])),
        outputs = [output],
        env = ctx.attr.environment,
        mnemonic = "BrowserStdRustc",
        progress_message = "Compiling atomics-enabled browser std crate %{label}",
        resource_set = _resources,
    )
    return [DefaultInfo(files = depset([output])), _StdCrateInfo(output = output, closure = depset([output], transitive = dependencies))]

def _resources(os_name, inputs):
    return {"cpu": 1, "memory": 768}

_crate = rule(
    implementation = _crate_impl,
    attrs = {
        "crate_root": attr.label(allow_single_file = [".rs"], mandatory = True),
        "srcs": attr.label_list(allow_files = True),
        "crate_name": attr.string(mandatory = True),
        "edition": attr.string(mandatory = True),
        "version": attr.string(mandatory = True),
        "crate_features": attr.string_list(),
        "flags": attr.string_list(),
        "opt_level": attr.string(mandatory = True),
        "codegen_units": attr.int(),
        "deps": attr.label_keyed_string_dict(providers = [_StdCrateInfo]),
        "build_script": attr.label(providers = [_StdBuildInfo]),
        "compiler": attr.label(allow_single_file = True, mandatory = True),
        "compiler_files": attr.label_list(allow_files = True),
        "environment": attr.string_dict(),
        "_wrapper": attr.label(default = Label("@rules_rust//util/process_wrapper"), executable = True, cfg = "exec"),
    },
)

def _receipt_impl(ctx):
    output = ctx.actions.declare_file("construction-receipt.json")
    bun_file_action(
        ctx,
        ctx.file._receipt,
        arguments = [ctx.file.metadata.path, output.path] + [file.path for file in ctx.files.stdlib],
        inputs = [ctx.file.metadata] + ctx.files.stdlib,
        source_files = [],
        outputs = [output],
        mnemonic = "BrowserStdReceipt",
    )
    return [DefaultInfo(files = depset([output]))]

_receipt = rule(
    implementation = _receipt_impl,
    attrs = {
        "metadata": attr.label(allow_single_file = True, mandatory = True),
        "stdlib": attr.label_list(allow_files = True),
        "_receipt": attr.label(default = Label("//build_defs/wasix/browser/std:receipt.mts"), allow_single_file = True),
    },
    toolchains = BUN_SOURCE_TOOLCHAINS,
)

def browser_std(graph, rust, target_env):
    """Instantiate the conventional locked std graph and two matched toolchains."""
    if rust["profile"].get("opt-level") != 3 or rust["profile"].get("lto") != True:
        fail("Browser std recipe requires the canonical release opt3/fat-LTO profile")
    native.filegroup(name = "compiler_files", srcs = native.glob(["bin/rustc", "lib/*.so*", "lib/rustlib/x86_64-unknown-linux-gnu/bin/**"]))
    native.filegroup(name = "rustc", srcs = ["bin/rustc"])
    native.filegroup(name = "rustdoc", srcs = ["bin/rustdoc"])
    native.filegroup(name = "cargo", srcs = ["bin/cargo"])
    native.filegroup(name = "rust_lld", srcs = ["lib/rustlib/x86_64-unknown-linux-gnu/bin/rust-lld"])
    native.filegroup(name = "rustc_lib", srcs = native.glob(["lib/*.so*", "lib/rustlib/x86_64-unknown-linux-gnu/lib/*.so*"]))
    rust_stdlib_filegroup(name = "host_stdlib", srcs = native.glob(["lib/rustlib/x86_64-unknown-linux-gnu/lib/*.rlib", "lib/rustlib/x86_64-unknown-linux-gnu/lib/*.so*"]))
    std_sources = native.glob(["sources/lib/rustlib/src/rust/library/**"], exclude = ["**/tests/**", "**/benches/**"])
    for row in graph:
        sources = std_sources if row["directory"].startswith("sources/") else native.glob([row["directory"] + "/**"], exclude = ["**/tests/**", "**/benches/**"])
        env = row["env"] | {"CARGO_CRATE_NAME": row["crate_name"]}
        script = None
        if row["build"]:
            rust_binary(
                name = row["name"] + "_build_binary",
                crate_root = row["build"],
                srcs = [file for file in sources if file.endswith(".rs")],
                compile_data = sources,
                crate_name = row["name"] + "_build",
                edition = row["edition"],
                version = row["version"],
                crate_features = row["features"],
                rustc_env = env,
                rustc_flags = ["--cap-lints=allow"],
            )
            build_env = env | target_env | {"HOST": "x86_64-unknown-linux-gnu", "TARGET": rust["target"], "OPT_LEVEL": str(row["profile"].get("opt-level", rust["profile"]["opt-level"])), "PROFILE": "release", "DEBUG": "false", "NUM_JOBS": "1"}
            for feature in row["features"]:
                build_env["CARGO_FEATURE_" + feature.replace("-", "_").upper()] = "1"
            script = ":" + row["name"] + "_build"
            _script(name = row["name"] + "_build", binary = ":" + row["name"] + "_build_binary", manifest = row["directory"] + "/Cargo.toml", srcs = sources, compiler = "bin/rustc", compiler_files = [":compiler_files"], environment = build_env)
        _crate(name = row["name"], crate_name = row["crate_name"], crate_root = row["root"], srcs = sources, edition = row["edition"], version = row["version"], crate_features = row["features"], flags = rust["flags"] + row["profile"].get("rustflags", []), opt_level = str(row["profile"].get("opt-level", rust["profile"]["opt-level"])), codegen_units = row["profile"].get("codegen-units", 0), environment = env, deps = {":" + target: name for name, target in row["deps"].items()}, build_script = script, compiler = "bin/rustc", compiler_files = [":compiler_files"])
    rust_stdlib_filegroup(name = "stdlib", srcs = [":" + row["name"] for row in graph])
    _receipt(name = "construction_receipt", metadata = "construction.json", stdlib = [":stdlib"])
    for name, target, stdlib, flags, dylib in [("host", "x86_64-unknown-linux-gnu", ":host_stdlib", ["-Zlinker-features=-lld"], ".so"), ("wasm", rust["target"], ":stdlib", rust["flags"], ".wasm")]:
        rust_toolchain(
            name = name + "_compiler",
            rustc = ":rustc", rust_doc = ":rustdoc", cargo = ":cargo", rustc_lib = ":rustc_lib", rust_std = stdlib,
            linker = ":rust_lld", linker_type = "direct",
            exec_triple = "x86_64-unknown-linux-gnu", target_triple = target,
            binary_ext = "" if name == "host" else ".wasm", staticlib_ext = ".a", dylib_ext = dylib,
            default_edition = "2024", stdlib_linkflags = ["-ldl", "-lpthread"] if name == "host" else [],
            extra_rustc_flags = flags, extra_exec_rustc_flags = ["-Zlinker-features=-lld"] if name == "host" else [],
            opt_level = {"opt": "3", "dbg": "0", "fastbuild": "0"},
            version = "1.90.0", channel = "nightly", iso_date = "2025-07-05",
        )
def _nightly_impl(settings, attr):
    # A standalone std/receipt request must select the same configured producer
    # as the actual browser crate; otherwise its identical sysroot compiles twice.
    return {
        "//command_line_option:platforms": "@rules_rust//rust/platform:wasm32",
        "//command_line_option:compilation_mode": "opt",
        "@rules_rust//rust/toolchain/channel:channel": "nightly",
        "@rules_rust//rust/settings:lto": "fat",
    }

_nightly = transition(implementation = _nightly_impl, inputs = [], outputs = ["//command_line_option:platforms", "//command_line_option:compilation_mode", "@rules_rust//rust/toolchain/channel:channel", "@rules_rust//rust/settings:lto"])

def _artifact_impl(ctx):
    info = ctx.attr.artifact[0][DefaultInfo]
    return [DefaultInfo(files = info.files)]

nightly_artifact = rule(
    implementation = _artifact_impl,
    attrs = {
        "artifact": attr.label(cfg = _nightly, mandatory = True),
        "_allowlist_function_transition": attr.label(default = Label("@bazel_tools//tools/allowlists/function_transition_allowlist")),
    },
)
