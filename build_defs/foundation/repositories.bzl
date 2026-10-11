"""Tracked projections of the existing pinned language tools and lockfile."""

def _quoted_assignments(text):
    """Read the quoted scalar assignments used by the Bun acquisition manifest."""
    result = {}
    section = ""
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1]
            result[section] = {}
        elif "=" in line:
            key, value = line.split("=", 1)
            value = value.strip()
            if not section or not value.startswith('"') or not value.endswith('"'):
                fail("Expected a section and quoted scalar in tools/dev/bun.toml: " + line)
            result[section][key.strip()] = value[1:-1]
        else:
            fail("Unsupported tools/dev/bun.toml entry: " + line)
    return result

def _host_bun_platform(ctx):
    os = ctx.os.name.lower()
    if os.startswith("mac"):
        os = "darwin"
    elif os.startswith("windows"):
        os = "windows"
    elif os != "linux":
        fail("No declared Bun asset for host OS " + ctx.os.name)
    arch = ctx.os.arch.lower()
    arch = {"amd64": "x64", "x86_64": "x64", "arm64": "aarch64"}.get(arch, arch)
    return os + "-" + arch

def _download_bun(ctx, platform, output):
    asset = _quoted_assignments(ctx.read(ctx.attr.manifest)).get("assets." + platform)
    if not asset:
        fail("No declared Bun asset for " + platform)
    for field in ["url", "sha256", "binary_path", "binary_sha256"]:
        if not asset.get(field):
            fail("Bun asset %s is missing %s" % (platform, field))
    ctx.download_and_extract(url = asset["url"], sha256 = asset["sha256"])
    ctx.symlink(asset["binary_path"], output)
    ctx.file("BUILD.bazel", 'exports_files([%s], visibility = ["//visibility:public"])\n' % repr(output))
    return ctx.repo_metadata(reproducible = True)

def _bun_runtime_impl(ctx):
    return _download_bun(ctx, _host_bun_platform(ctx), "bun")

bun_runtime_repository = repository_rule(
    implementation = _bun_runtime_impl,
    attrs = {"manifest": attr.label(default = Label("//tools/dev:bun.toml"), allow_single_file = True)},
)

_BUN_PLATFORMS = {
    "darwin-aarch64": ["@platforms//os:macos", "@platforms//cpu:aarch64"],
    "darwin-x64": ["@platforms//os:macos", "@platforms//cpu:x86_64"],
    "linux-aarch64": ["@platforms//os:linux", "@platforms//cpu:aarch64"],
    "linux-x64": ["@platforms//os:linux", "@platforms//cpu:x86_64"],
    "windows-x64": ["@platforms//os:windows", "@platforms//cpu:x86_64"],
}

def _bun_asset_impl(ctx):
    platform = ctx.attr.runtime_platform
    return _download_bun(ctx, platform, "bun.exe" if platform.startswith("windows-") else "bun")

_bun_asset_repository = repository_rule(
    implementation = _bun_asset_impl,
    attrs = {
        "manifest": attr.label(allow_single_file = True, mandatory = True),
        "runtime_platform": attr.string(mandatory = True, values = _BUN_PLATFORMS.keys()),
    },
)

def _bun_toolchains_repository_impl(ctx):
    lines = [
        'load(%s, "bun_runtime_toolchain")' % repr(str(ctx.attr.definition)),
        'package(default_visibility = ["//visibility:public"])',
    ]
    for platform in sorted(ctx.attr.binary_sha256s):
        name = platform.replace("-", "_")
        binary = "bun.exe" if platform.startswith("windows-") else "bun"
        lines.extend([
            "bun_runtime_toolchain(name = %s, binary = %s, runtime_platform = %s, binary_sha256 = %s)" % (
                repr(name + "_runtime"),
                repr("@bun_" + name + "//:" + binary),
                repr(platform),
                repr(ctx.attr.binary_sha256s[platform]),
            ),
            "toolchain(name = %s, toolchain = %s, toolchain_type = %s, exec_compatible_with = %s)" % (
                repr(name),
                repr(":" + name + "_runtime"),
                repr(str(ctx.attr.toolchain_type)),
                repr(_BUN_PLATFORMS[platform]),
            ),
        ])
    ctx.file("BUILD.bazel", "\n".join(lines) + "\n")
    return ctx.repo_metadata(reproducible = True)

_bun_toolchains_repository = repository_rule(
    implementation = _bun_toolchains_repository_impl,
    attrs = {
        "binary_sha256s": attr.string_dict(mandatory = True),
        "definition": attr.label(default = Label("//build_defs/foundation:bun-toolchain.bzl")),
        "toolchain_type": attr.label(default = Label("//build_defs/foundation:bun_toolchain_type")),
    },
)

def _bun_toolchains_impl(ctx):
    manifest = Label("//tools/dev:bun.toml")
    assets = _quoted_assignments(ctx.read(manifest))
    hashes = {}
    for section, asset in assets.items():
        if not section.startswith("assets."):
            fail("Unknown Bun manifest section: " + section)
        platform = section[len("assets."):]
        if platform not in _BUN_PLATFORMS:
            fail("No declared Bazel execution constraints for Bun asset " + platform)
        digest = asset.get("binary_sha256", "")
        if len(digest) != 64 or any([character not in "0123456789abcdef" for character in digest.elems()]):
            fail("Bun asset %s has an invalid binary SHA-256" % platform)
        hashes[platform] = digest
        _bun_asset_repository(name = "bun_" + platform.replace("-", "_"), manifest = manifest, runtime_platform = platform)
    if not hashes:
        fail("Bun manifest declares no execution assets")
    _bun_toolchains_repository(name = "bun_toolchains", binary_sha256s = hashes)
    return ctx.extension_metadata(root_module_direct_deps = ["bun_toolchains"], root_module_direct_dev_deps = [], reproducible = True)

bun_toolchains = module_extension(implementation = _bun_toolchains_impl)

def _toolchain_metadata_impl(ctx):
    ctx.watch(ctx.path(ctx.attr.bun))
    # An external process opening a path does not register a repository read.
    # Watch every source and the converter before invoking the pinned runtime.
    for source in [ctx.attr.converter, ctx.attr.compatibility, ctx.attr.deployment_policy, ctx.attr.versions, ctx.attr.rust, ctx.attr.package, ctx.attr.query, ctx.attr.lockfile, ctx.attr.cargo, ctx.attr.query_rust]:
        ctx.read(source)
    # Cargo discovers scripts and additional targets even without manifest keys.
    query_root = ctx.path(ctx.attr.query_rust).dirname
    for relative in ["build.rs", "src/main.rs", "src/bin", "tests", "examples", "benches"]:
        additional_target = query_root.get_child(relative)
        ctx.watch(additional_target)
        if additional_target.exists:
            fail("Native query Rust does not yet support an automatically discovered " + relative)
    result = ctx.execute([
        ctx.path(ctx.attr.bun),
        ctx.path(ctx.attr.converter),
        ctx.path(ctx.attr.versions),
        ctx.path(ctx.attr.rust),
        ctx.path(ctx.attr.package),
        ctx.path(ctx.attr.query),
        ctx.path(ctx.attr.lockfile),
        ctx.path(ctx.attr.cargo),
        ctx.path(ctx.attr.query_rust),
    ], quiet = True)
    if result.return_code:
        fail("Cannot import pinned language tools: " + result.stderr)
    data = json.decode(result.stdout)
    ctx.file("apple-platforms.bzl", "APPLE_DEPLOYMENT_TARGETS = " + repr(data["apple_deployment_targets"]) + "\n")
    ctx.file("toolchains.json", json.encode(data["language_acquisition"]))
    ctx.file("node-version", data["node"] + "\n")
    ctx.file("typescript.json", json.encode({
        "$schema": "https://docs.aspect.build/rules/aspect_rules_js/docs/npm_translate_lock",
        "version": data["typescript"]["version"],
        "integrity": data["typescript"]["integrity"],
    }))
    ctx.file("query-package-type.bzl", "QUERY_PACKAGE_TYPE = " + repr(data["query_package_type"]) + "\nQUERY_NPM_NAME = " + repr(data["query_npm_name"]) + "\n")
    rust = data["query_rust"]
    ctx.file("query-rust.bzl", "QUERY_RUST_CRATE_NAME = " + repr(rust["crate_name"]) + "\nQUERY_RUST_EDITION = " + repr(rust["edition"]) + "\nQUERY_RUST_VERSION = " + repr(rust["version"]) + "\nQUERY_RUST_ENV = " + repr(rust["env"]) + "\n")
    ctx.file("BUILD.bazel", 'exports_files(["toolchains.json", "node-version", "typescript.json", "query-package-type.bzl", "query-rust.bzl", "apple-platforms.bzl"], visibility = ["//visibility:public"])\n')
    return ctx.repo_metadata(reproducible = True)

toolchain_metadata_repository = repository_rule(
    implementation = _toolchain_metadata_impl,
    attrs = {
        "bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
        "converter": attr.label(default = Label("//build_defs/foundation:toolchain-metadata.mts"), allow_single_file = True),
        "deployment_policy": attr.label(default = Label("//build_defs/host:deployment-policy.mts"), allow_single_file = True),
        "versions": attr.label(default = Label("//:.prototools"), allow_single_file = True),
        "rust": attr.label(default = Label("//:rust-toolchain.toml"), allow_single_file = True),
        "package": attr.label(default = Label("//:package.json"), allow_single_file = True),
        "query": attr.label(default = Label("//src/query/ts:package.json"), allow_single_file = True),
        "lockfile": attr.label(default = Label("//:bun.lock"), allow_single_file = True),
        "cargo": attr.label(default = Label("//:Cargo.toml"), allow_single_file = True),
        "query_rust": attr.label(default = Label("//src/query/rust:Cargo.toml"), allow_single_file = True),
        "compatibility": attr.label(default = Label("//tools/release:platform-compatibility-policy.mts"), allow_single_file = True),
    },
)
