"""Immutable, separately patched browser source and compiler acquisition."""

load("@aspect_rules_js//npm:repositories.bzl", "npm_import")

_JS_COMMIT = "93b8b738ebd3ee57e118da0f0eb795b97d5b999e"
_JS_ARCHIVE_SHA256 = "ca5df306ffcb260fb3086e89d450aafac106e200ccf7b49bb03c348bc2208712"
_BINDGEN_SHA256 = "f36a778bb0bdc5b04f6c6070ba7d0c51546a6ac7104aee302136894ac52f9e62"
_BINARYEN_SHA256 = "3dc677006555b355ea2da5e82602065a161d5e83eaefd3f759afa00b96e83212"

def _run_metadata(ctx, arguments):
    result = ctx.execute([ctx.path(ctx.attr.bun), ctx.path(ctx.attr.converter)] + arguments, quiet = True)
    if result.return_code:
        fail("Cannot import canonical browser construction inputs: " + result.stderr)
    return json.decode(result.stdout)

def _prefixed_patch(text, directory):
    lines = []
    for line in text.splitlines():
        if line.startswith("diff --git a/"):
            line = line.replace(" a/", " a/" + directory + "/").replace(" b/", " b/" + directory + "/")
        elif line.startswith("--- a/") or line.startswith("+++ b/"):
            line = line[:6] + directory + "/" + line[6:]
        lines.append(line)
    return "\n".join(lines) + "\n"

def _sources_impl(ctx):
    ctx.read(ctx.attr.source_manifest)
    ctx.read(ctx.attr.converter)
    ctx.watch(ctx.path(ctx.attr.bun))
    contract = _run_metadata(ctx, ["sources", ctx.path(ctx.attr.source_manifest)])
    directories = {}
    for source in contract["sources"]:
        directory = source["directory"]
        directories[source["name"]] = directory
        if source["name"] == "wasmer-js":
            if source["commit"] != _JS_COMMIT:
                fail("Browser JS commit changed; verify the immutable commit archive digest for this source")
            ctx.download_and_extract(
                url = "https://codeload.github.com/wasmerio/wasmer-js/tar.gz/" + source["commit"],
                sha256 = _JS_ARCHIVE_SHA256,
                type = "tar.gz",
                stripPrefix = "wasmer-sdk-" + source["commit"],
                output = directory,
            )
        else:
            ctx.download_and_extract(url = source["url"], sha256 = source["sha256"], type = "tar.gz", stripPrefix = directory, output = directory)
            ctx.file("_original_manifests/" + source["name"] + ".toml", ctx.read(directory + "/Cargo.toml"))
    for patch in contract["patches"]:
        original = ctx.path(ctx.attr.source_manifest).dirname.get_child("patches", patch["name"])
        projected = "_patches/" + patch["name"]
        ctx.file(projected, _prefixed_patch(ctx.read(original), directories[patch["source"]]))
        ctx.patch(ctx.path(projected), strip = 1)
    data = _run_metadata(ctx, ["context", ctx.path(ctx.attr.source_manifest), ctx.path(".")])
    for source in data["sources"]:
        ctx.symlink(source["directory"], "cargo/" + source["directory"])
    ctx.file("cargo/Cargo.toml", ctx.read("Cargo.bazel.toml"))
    ctx.file("cargo/Cargo.lock", ctx.read("wasmer-js/Cargo.bazel.lock"))
    data["sources"][0]["archive_sha256"] = _JS_ARCHIVE_SHA256
    data["compilerSources"] = {"wasm-bindgen": {"version": data["bindgen"]["version"], "sha256": _BINDGEN_SHA256}, "wasm-opt": {"version": "117", "sha256": _BINARYEN_SHA256}}
    ctx.file("metadata.json", json.encode(data))
    cargo_sources = {}
    patch_prefix = str(ctx.attr.source_manifest).split(":")[0] + ":"
    for crate, row in data["cargoSources"].items():
        cargo_sources[crate] = dict(row, patches = [patch_prefix + path for path in row["patches"]])
    ctx.file("cargo-sources.json", json.encode(cargo_sources))
    ctx.file("rust-construction.json", json.encode({"rust": data["rust"]}))
    ctx.file("metadata.bzl", "BROWSER = " + repr(data) + "\n")
    ctx.file("BUILD.bazel", """package(default_visibility = ["//visibility:public"])
exports_files(["metadata.bzl", "metadata.json", "cargo-sources.json", "rust-construction.json", "cargo/Cargo.toml", "cargo/Cargo.lock", "wasmer-js/Cargo.toml", "wasmer-js/Cargo.lock", "wasmer-js/Cargo.bazel.lock", "wasmer-js/package.json", "wasmer-js/package-lock.json", "wasmer-js/rust-toolchain.toml", "wasmer-js/.cargo/config.toml", "wasmer-js/src/lib.rs", "wasmer-js/src-js/worker.js", "wasmer-js/LICENSE"])
filegroup(name = "rust_sources", srcs = glob(["wasmer-js/src/**/*.rs"]))
filegroup(name = "rollup_sources", srcs = glob(["wasmer-js/src-js/**"]) + ["wasmer-js/rollup.config.mjs", "wasmer-js/tsconfig.json", "wasmer-js/package.json"])
""")
    return ctx.repo_metadata(reproducible = True)

browser_sources_repository = repository_rule(
    implementation = _sources_impl,
    attrs = {
        "source_manifest": attr.label(default = Label("//src/wasix/browser-host:source.toml"), allow_single_file = True),
        "converter": attr.label(default = Label("//build_defs/wasix/browser:metadata.mts"), allow_single_file = True),
        "bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
    },
)

def _compiler_tool_impl(ctx):
    ctx.download_and_extract(url = ctx.attr.url, sha256 = ctx.attr.sha256, stripPrefix = ctx.attr.strip_prefix)
    ctx.file("BUILD.bazel", 'exports_files([%s], visibility = ["//visibility:public"])\n' % repr(ctx.attr.binary))

_compiler_tool = repository_rule(
    implementation = _compiler_tool_impl,
    attrs = {"url": attr.string(mandatory = True), "sha256": attr.string(mandatory = True), "strip_prefix": attr.string(mandatory = True), "binary": attr.string(mandatory = True)},
)

def _npm_hub_impl(ctx):
    metadata = json.decode(ctx.read(ctx.attr.metadata))
    acquisition = metadata["acquisition"]
    lines = ["BROWSER_NPM = {"]
    for key, row in acquisition["packages"].items():
        lines.append("    Label(%s): %s," % (repr("@browser_npm_" + key + "//:pkg"), repr(key)))
    lines.append("}\n")
    ctx.file("defs.bzl", "\n".join(lines))
    ctx.file("acquisition.json", json.encode(acquisition))
    ctx.file("BUILD.bazel", 'exports_files(["defs.bzl", "acquisition.json"], visibility = ["//visibility:public"])\n')
    return ctx.repo_metadata(reproducible = True)

_npm_hub = repository_rule(implementation = _npm_hub_impl, attrs = {"metadata": attr.label(mandatory = True)})

def _compilers_impl(ctx):
    tags = [tag for module in ctx.modules for tag in module.tags.configure]
    if len(tags) != 1:
        fail("Exactly one canonical isolated browser construction context is required")
    for module in ctx.modules:
        if module.tags.configure and not module.is_root:
            fail("Only the root module may configure browser compiler acquisition")
    metadata = json.decode(ctx.read(tags[0].metadata))
    for key, row in metadata["acquisition"]["packages"].items():
        npm_import(name = "browser_npm_" + key, package = row["package"], version = row["version"], integrity = row["integrity"], lifecycle_hooks = [])
    _npm_hub(name = "browser_npm", metadata = tags[0].metadata)
    version = metadata["bindgen"]["version"]
    if version != "0.2.101":
        fail("Browser wasm-bindgen lock version changed; verify its exact CLI archive digest")
    _compiler_tool(
        name = "browser_wasm_bindgen_linux_x64",
        url = "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/%s/wasm-bindgen-%s-x86_64-unknown-linux-musl.tar.gz" % (version, version),
        sha256 = _BINDGEN_SHA256,
        strip_prefix = "wasm-bindgen-%s-x86_64-unknown-linux-musl" % version,
        binary = "wasm-bindgen",
    )
    # wasm-pack 0.15.0's installer selects Binaryen version_117; preserve that
    # compiler, without its ambient PATH override or any wasm-pack scheduler.
    _compiler_tool(
        name = "browser_binaryen_linux_x64",
        url = "https://github.com/WebAssembly/binaryen/releases/download/version_117/binaryen-version_117-x86_64-linux.tar.gz",
        sha256 = _BINARYEN_SHA256,
        strip_prefix = "binaryen-version_117",
        binary = "bin/wasm-opt",
    )
    return ctx.extension_metadata(root_module_direct_deps = ["browser_npm", "browser_wasm_bindgen_linux_x64", "browser_binaryen_linux_x64"], root_module_direct_dev_deps = [], reproducible = True)

browser_compilers = module_extension(
    implementation = _compilers_impl,
    tag_classes = {"configure": tag_class(attrs = {"metadata": attr.label(mandatory = True)})},
)
