"""Native rules_rust construction using conventional Cargo compile facts."""

load("@cargo_crates//:defs.bzl", "all_crate_deps", "crate_deps")
load("@native_cargo_metadata//:cargo.bzl", "CARGO")
load("@rules_rust//cargo:defs.bzl", "cargo_build_script", "cargo_toml_env_vars")
load("@rules_rust//rust:defs.bzl", "rust_binary", "rust_doc_test", "rust_library", "rust_shared_library", "rust_static_library", "rust_test")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")

# These are the canonical first-party Cargo conditions currently in the workspace.
# Unknown conditions fail instead of silently dropping a dependency. The labels
# are the same exact triple conditions used by crate_universe for external deps.
_TARGET_CONDITIONS = {
    'cfg(all(target_os = "macos", target_arch = "aarch64"))': ["aarch64-apple-darwin"],
    'cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))': ["x86_64-unknown-linux-gnu"],
    'cfg(all(target_os = "linux", target_arch = "aarch64", target_env = "gnu"))': ["aarch64-unknown-linux-gnu"],
    'cfg(all(target_os = "windows", target_arch = "x86_64", target_env = "msvc"))': ["x86_64-pc-windows-msvc"],
    "cfg(unix)": ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "aarch64-apple-darwin", "aarch64-apple-ios", "aarch64-apple-ios-sim", "aarch64-linux-android", "x86_64-linux-android"],
}

def cargo_features(facts, features = [], default_features = True):
    """Expand source feature names, preserving optional dependency activation."""
    enabled = {feature: True for feature in features}
    if default_features and "default" in facts["features"]:
        enabled["default"] = True
    for _ in range(len(facts["features"]) + 1):
        added = False
        for feature in enabled.keys():
            if feature not in facts["features"]:
                declaration = facts["dependencies"].get(feature)
                if type(declaration) != "dict" or not declaration.get("optional", False):
                    fail("Unknown conventional Cargo feature " + feature)
            for item in facts["features"].get(feature, []):
                if "/" not in item and not item.startswith("dep:") and item not in enabled:
                    enabled[item] = True
                    added = True
        if not added:
            break
    return enabled.keys()

def _active(declaration, name, facts, features):
    if type(declaration) == "string" or not declaration.get("optional", False):
        return True
    if name in features:
        return True
    for feature in features:
        for item in facts["features"].get(feature, []):
            if item == "dep:" + name or item.startswith(name + "/"):
                return True
    return False

def _package_name(package_name):
    return package_name or native.package_name()

def _source_prefix(package_name):
    package_name = _package_name(package_name)
    if package_name == native.package_name():
        return ""
    prefix = native.package_name() + "/" if native.package_name() else ""
    if not package_name.startswith(prefix):
        fail("Cargo source package must be inside its Bazel owner: " + package_name)
    return package_name.removeprefix(prefix) + "/"

def _table_dependencies(table, facts, features, path_dependencies, proc_macro_names, crate_dependencies, package_name):
    normal = []
    macros = []
    for name, declaration in table.items():
        if not _active(declaration, name, facts, features):
            continue
        if type(declaration) == "dict" and "path" in declaration:
            if name not in path_dependencies:
                fail("Missing native Cargo path dependency " + name + " for " + native.package_name())
            normal.append(path_dependencies[name])
        elif name in proc_macro_names:
            macros.extend(crate_dependencies([name], package_name = package_name))
        else:
            normal.extend(crate_dependencies([name], package_name = package_name))
    return normal, macros

def _dependencies(facts, features, section, path_dependencies, proc_macro_names, crate_dependencies = crate_deps, include_dev = False, package_name = None):
    table = facts[section] | facts["dev_dependencies"] if include_dev else facts[section]
    package_name = _package_name(package_name)
    normal, macros = _table_dependencies(table, facts, features, path_dependencies, proc_macro_names, crate_dependencies, package_name)
    cargo_section = section.replace("_", "-")
    for condition, table in facts["target_dependencies"].items():
        dependencies = table.get(cargo_section, {})
        if include_dev:
            dependencies = dependencies | table.get("dev-dependencies", {})
        if not dependencies:
            continue
        if condition not in _TARGET_CONDITIONS:
            fail("Unrepresented Cargo target condition " + condition + " for " + native.package_name())
        target_normal, target_macros = _table_dependencies(dependencies, facts, features, path_dependencies, proc_macro_names, crate_dependencies, package_name)
        normal = normal + select({"@rules_rust//rust/platform:" + triple: target_normal for triple in _TARGET_CONDITIONS[condition]} | {"//conditions:default": []})
        macros = macros + select({"@rules_rust//rust/platform:" + triple: target_macros for triple in _TARGET_CONDITIONS[condition]} | {"//conditions:default": []})
    return normal, macros

def _readme(facts, source_prefix = ""):
    return [source_prefix + facts["readme"]] if facts["readme"] else []

def _release_flags(facts):
    strip = facts.get("release_strip")
    if strip == None:
        return []
    if strip != "symbols":
        fail("Unrepresented conventional Cargo release strip setting: " + str(strip))
    return select({"//build_defs/languages:release": ["-Cstrip=" + strip], "//conditions:default": []})

def cargo_package_env(name = "cargo_env", workspace_manifest = "//:Cargo.toml", package_name = None):
    cargo_toml_env_vars(
        name = name,
        src = _source_prefix(package_name) + "Cargo.toml",
        workspace = workspace_manifest,
    )

def cargo_generator(name = "build_script", path_dependencies = {}, srcs = [], data = [], tools = [], build_script_env = {}, features = [], default_features = True, proc_macro_names = [], cargo_facts = CARGO, crate_dependencies = crate_deps, package_name = None, cargo_env = ":cargo_env"):
    package_name = _package_name(package_name)
    prefix = _source_prefix(package_name)
    facts = cargo_facts[package_name]
    if not facts["build"]:
        fail("Cargo manifest has no build script for " + native.package_name())
    enabled = cargo_features(facts, features, default_features)
    deps, macros = _dependencies(facts, enabled, "build_dependencies", path_dependencies, proc_macro_names, crate_dependencies, package_name = package_name)
    link_deps, _ = _dependencies(facts, enabled, "dependencies", path_dependencies, proc_macro_names, crate_dependencies, package_name = package_name)
    cargo_build_script(
        name = name,
        srcs = [prefix + facts["build"]] + srcs,
        crate_root = prefix + facts["build"],
        # Cargo's private build-script name also bounds Windows object paths.
        crate_name = "build_script_build",
        rustc_env = {"CARGO_CRATE_NAME": "build_script_build"},
        pkg_name = facts["name"],
        edition = facts["edition"],
        version = facts["version"],
        crate_features = enabled,
        deps = deps,
        link_deps = link_deps,
        proc_macro_deps = macros,
        rustc_env_files = [cargo_env],
        data = [prefix + "Cargo.toml"] + data,
        tools = tools,
        build_script_env = ({"CARGO_MANIFEST_DIR": package_name} if prefix else {}) | build_script_env,
        use_default_shell_env = False,
        links = facts["links"],
    )

def cargo_generator_test(name = "generator_test", path_dependencies = {}, srcs = [], features = [], default_features = True, proc_macro_names = [], **kwargs):
    facts = CARGO[native.package_name()]
    if not facts["build"]:
        fail("Cargo manifest has no build script for " + native.package_name())
    enabled = cargo_features(facts, features, default_features)
    deps, macros = _dependencies(facts, enabled, "build_dependencies", path_dependencies, proc_macro_names)
    rust_test(
        name = name,
        srcs = [facts["build"]] + srcs,
        crate_root = facts["build"],
        edition = facts["edition"],
        version = facts["version"],
        crate_features = enabled,
        deps = deps,
        proc_macro_deps = macros,
        rustc_env_files = [":cargo_env"],
        **kwargs
    )

def cargo_library(name = "lib", kind = "rlib", path_dependencies = {}, proc_macro_names = [], features = [], default_features = True, build_script = None, compile_data = [], rustc_env = {}, rustc_flags = [], cargo_facts = CARGO, crate_dependencies = crate_deps, package_name = None, cargo_env = ":cargo_env", **kwargs):
    package_name = _package_name(package_name)
    prefix = _source_prefix(package_name)
    facts = cargo_facts[package_name]
    if not facts["library"]:
        fail("Cargo manifest has no library for " + native.package_name())
    if bool(facts["build"]) != bool(build_script):
        fail("Native Cargo build script must match the conventional manifest for " + native.package_name())
    enabled = cargo_features(facts, features, default_features)
    deps, macros = _dependencies(facts, enabled, "dependencies", path_dependencies, proc_macro_names, crate_dependencies, package_name = package_name)
    constructor = {"rlib": rust_library, "cdylib": rust_shared_library, "staticlib": rust_static_library}.get(kind)
    if not constructor:
        fail("Unsupported native Cargo library kind " + kind)
    constructor(
        name = name,
        srcs = native.glob([prefix + "src/**/*.rs"], exclude = [prefix + "src/main.rs", prefix + "src/bin/**/*.rs"]),
        crate_root = prefix + facts["library"],
        crate_name = facts["crate_name"],
        edition = facts["edition"],
        version = facts["version"],
        crate_features = enabled,
        deps = deps + ([build_script] if build_script else []),
        proc_macro_deps = macros,
        rustc_env_files = [cargo_env],
        rustc_env = ({"CARGO_MANIFEST_DIR": package_name} if prefix else {}) | rustc_env,
        rustc_flags = rustc_flags + _release_flags(facts),
        compile_data = _readme(facts, prefix) + native.glob([prefix + "src/**/*"], exclude = [prefix + "src/**/*.rs"], allow_empty = True) + compile_data,
        **kwargs
    )

def _isolated_cache_test_impl(ctx):
    binary = ctx.attr.binary[DefaultInfo].files_to_run.executable
    return bun_test_entrypoint(ctx, runner = ctx.file._runner, arguments = [binary], files = [binary], source_files = [ctx.file._runner], additional_runfiles = ctx.attr.binary[DefaultInfo].default_runfiles) + [ctx.attr.binary[RunEnvironmentInfo]]

_isolated_cache_test = rule(
    implementation = _isolated_cache_test_impl,
    test = True,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "binary": attr.label(mandatory = True, executable = True, cfg = "target"),
        "_runner": attr.label(default = "//build_defs/languages:isolated-cache-test.mts", allow_single_file = True),
    }),
    toolchains = BUN_SOURCE_TOOLCHAINS,
)

def cargo_library_test(name = "unit_test", crate = ":lib", data = [], tags = [], isolated_cache = False, cargo_facts = CARGO, all_dependencies = all_crate_deps, package_name = None, cargo_env = ":cargo_env", path_dependencies = {}, **kwargs):
    package_name = _package_name(package_name)
    facts = cargo_facts[package_name]
    rust_test(
        name = name + "_binary" if isolated_cache else name,
        crate = crate,
        edition = facts["edition"],
        version = facts["version"],
        deps = all_dependencies(normal_dev = True, package_name = package_name) + path_dependencies.values(),
        proc_macro_deps = all_dependencies(proc_macro_dev = True, package_name = package_name),
        rustc_env_files = [cargo_env],
        rustc_env = {"CARGO_MANIFEST_DIR": package_name},
        data = data,
        tags = tags + (["manual"] if isolated_cache else []),
        **kwargs
    )
    if isolated_cache:
        _isolated_cache_test(name = name, binary = ":" + name + "_binary", args = bun_test_entrypoint_args(name), size = kwargs.get("size", "small"))

def cargo_integration_test(name, source, crate = ":lib", srcs = [], data = [], rustc_env = {}, features = [], default_features = True, path_dependencies = {}, proc_macro_names = [], cargo_facts = CARGO, crate_dependencies = crate_deps, package_name = None, cargo_env = ":cargo_env", **kwargs):
    """Compile a conventional external integration root against its actual library."""
    package_name = _package_name(package_name)
    facts = cargo_facts[package_name]
    enabled = cargo_features(facts, features, default_features)
    normal, macros = _dependencies(facts, enabled, "dependencies", path_dependencies, proc_macro_names, crate_dependencies, include_dev = True, package_name = package_name)
    rust_test(
        name = name,
        srcs = [source] + srcs,
        crate_root = source,
        edition = facts["edition"],
        version = facts["version"],
        crate_features = enabled,
        deps = [crate] + normal,
        proc_macro_deps = macros,
        rustc_env_files = [cargo_env],
        rustc_env = {"CARGO_MANIFEST_DIR": package_name} | rustc_env,
        data = data,
        **kwargs
    )

def cargo_doc_test(name = "doc_test", crate = ":lib", features = [], default_features = True, cargo_facts = CARGO, **kwargs):
    """Run maintained rustdoc tests with the conventional Cargo feature closure."""
    rust_doc_test(
        name = name,
        crate = crate,
        crate_features = cargo_features(cargo_facts[native.package_name()], features, default_features),
        **kwargs
    )

def cargo_binary(name, source, path_dependencies = {}, features = [], default_features = True, build_script = None, proc_macro_names = [], library = None, crate_dependencies = crate_deps, rustc_env = {}, rustc_flags = [], compile_data = [], cargo_facts = CARGO, package_name = None, cargo_env = ":cargo_env", **kwargs):
    package_name = _package_name(package_name)
    prefix = _source_prefix(package_name)
    facts = cargo_facts[package_name]
    enabled = cargo_features(facts, features, default_features)
    binaries = [target for target in facts["binaries"] if prefix + target["path"] == source]
    if not binaries and source == prefix + "src/main.rs":
        binaries = [{"name": facts["name"]}]
    if len(binaries) != 1:
        fail("Native binary must match a conventional Cargo target: " + source)
    for required in binaries[0].get("required-features", []):
        if required not in enabled:
            fail("Native binary requires conventional Cargo feature " + required)
    deps, macros = _dependencies(facts, enabled, "dependencies", path_dependencies, proc_macro_names, crate_dependencies, package_name = package_name)
    rust_binary(
        name = name,
        srcs = native.glob([prefix + "src/**/*.rs"]),
        crate_root = source,
        crate_name = binaries[0]["name"].replace("-", "_"),
        edition = facts["edition"],
        version = facts["version"],
        crate_features = enabled,
        deps = deps + ([build_script] if build_script else []) + ([library] if library else []),
        proc_macro_deps = macros,
        rustc_env_files = [cargo_env],
        rustc_env = ({"CARGO_MANIFEST_DIR": package_name} if prefix else {}) | rustc_env,
        rustc_flags = rustc_flags + _release_flags(facts),
        compile_data = _readme(facts, prefix) + compile_data,
        **kwargs
    )

def _napi_artifact_impl(ctx):
    output = ctx.actions.declare_file(ctx.attr.out)
    ctx.actions.symlink(output = output, target_file = ctx.file.library)
    return [DefaultInfo(files = depset([output]))]

napi_artifact = rule(
    implementation = _napi_artifact_impl,
    attrs = {
        "library": attr.label(allow_single_file = True, mandatory = True),
        "out": attr.string(mandatory = True),
    },
)
