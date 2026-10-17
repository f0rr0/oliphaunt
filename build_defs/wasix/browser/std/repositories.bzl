"""Pinned browser nightly acquisition and locked read-only std metadata import."""

_DATE = "2025-07-05"
_COMMIT = "e3843659e9f65f589d184d1221ac6149d5fa07b5"
_DIST_MANIFEST_SHA256 = "ee277f0e2373a6211c9f059bdc50416ab1e65538b82bfd6ab7c9075bfeac8ebd"
_ARCHIVES = {
    "rustc": ("x86_64-unknown-linux-gnu", "5d38c748377f4b2e38b1a40c5972f00a1ced501d736a75bd26798f6c5acce421"),
    "cargo": ("x86_64-unknown-linux-gnu", "4fd0ce38fe3b7e985c0ea5b8b53392d0ac8a3c17627ea05256082f7da01a8ec5"),
    "rust-std": ("x86_64-unknown-linux-gnu", "dc65f8d9d96f2e3ea1e39093e1cd9b4e8d229bd2313ba7348555b98116233cb0"),
    "rust-src": (None, "8f43ecd89129ffa4af2147f99a9fe0ec383be7391c8c61c586059e47b94be52b"),
}

def _checked(ctx, command, environment = {}):
    result = ctx.execute(command, environment = environment, quiet = True, timeout = 600)
    if result.return_code:
        fail("Cannot import pinned browser standard library: " + result.stderr)
    return result.stdout

def _impl(ctx):
    browser = json.decode(ctx.read(ctx.attr.metadata))["rust"]
    if browser["channel"] != "nightly-" + _DATE or browser["target"] != "wasm32-unknown-unknown" or browser["buildStd"] != ["std", "panic_abort"]:
        fail("Browser nightly std contract changed; review its source/target construction recipe")
    ctx.read(ctx.attr.converter)
    ctx.watch(ctx.path(ctx.attr.bun))
    for component, (host, checksum) in _ARCHIVES.items():
        suffix = "-" + host if host else ""
        archive_root = component + "-nightly" + suffix
        inner = component + suffix if component == "rust-std" else component
        ctx.download_and_extract(
            url = "https://static.rust-lang.org/dist/%s/%s.tar.xz" % (_DATE, archive_root),
            sha256 = checksum,
            stripPrefix = archive_root + "/" + inner,
            output = "sources" if component == "rust-src" else "",
        )
    library = ctx.path("sources/lib/rustlib/src/rust/library")
    cargo = ctx.path("bin/cargo")
    compiler = ctx.path("bin/rustc")
    # The target executor is Linux x64; acquisition metadata must also work
    # when another supported host merely loads this registered toolchain.
    if ctx.os.name != "linux" or ctx.os.arch not in ["amd64", "x86_64"]:
        host = {("mac os x", "aarch64"): "aarch64-apple-darwin", ("mac os x", "arm64"): "aarch64-apple-darwin", ("windows", "amd64"): "x86_64-pc-windows-msvc", ("windows", "x86_64"): "x86_64-pc-windows-msvc", ("linux", "aarch64"): "aarch64-unknown-linux-gnu", ("linux", "arm64"): "aarch64-unknown-linux-gnu"}.get((ctx.os.name, ctx.os.arch))
        if not host:
            fail("Unsupported browser nightly metadata host " + ctx.os.name + "/" + ctx.os.arch)
        ctx.download(url = "https://static.rust-lang.org/dist/%s/channel-rust-nightly.toml" % _DATE, sha256 = _DIST_MANIFEST_SHA256, output = "_metadata_tools/dist.toml")
        archives = json.decode(_checked(ctx, [str(ctx.path(ctx.attr.bun)), str(ctx.path(ctx.attr.converter)), "dist", str(ctx.path("_metadata_tools/dist.toml")), host]))
        for component, row in archives.items():
            ctx.download_and_extract(url = row["url"], sha256 = row["sha256"], stripPrefix = component + "-nightly-" + host + "/" + component, output = "_metadata_tools")
        suffix = ".exe" if ctx.os.name == "windows" else ""
        cargo = ctx.path("_metadata_tools/bin/cargo" + suffix)
        compiler = ctx.path("_metadata_tools/bin/rustc" + suffix)
    else:
        ctx.symlink(ctx.path("bin"), "_metadata_tools/bin")
        ctx.symlink(ctx.path("lib"), "_metadata_tools/lib")
    # Standard crate_universe reads this anchor's directory to find native
    # host tools. Browser resolution and construction use the same nightly.
    ctx.file("_metadata_tools/host-tools", "nightly-" + _DATE + "\n")
    environment = {
        "CARGO_HOME": str(ctx.path("_cargo")),
        "HOME": str(ctx.path("_home")),
        "RUSTC": str(compiler),
        "CARGO_ENCODED_RUSTFLAGS": json.decode('"\\u001f"').join(browser["flags"]),
    }
    # Cargo is only the conventional locked resolver here. Construction below
    # consists of separate native rustc and build-script actions.
    version = _checked(ctx, [str(compiler), "--version", "--verbose"])
    if "commit-hash: " + _COMMIT not in version:
        fail("Pinned browser nightly compiler and rust-src identities differ")
    metadata = _checked(ctx, [str(cargo), "metadata", "--locked", "--no-default-features", "--filter-platform", browser["target"], "--format-version", "1", "--features", "std/backtrace,std/panic-unwind", "--manifest-path", str(library.get_child("Cargo.toml"))], environment)
    ctx.file("cargo-metadata.json", metadata)
    graph = json.decode(_checked(ctx, [str(ctx.path(ctx.attr.bun)), str(ctx.path(ctx.attr.converter)), str(ctx.path("cargo-metadata.json")), str(ctx.path("."))]))
    cfg = _checked(ctx, [str(compiler), "--print", "cfg", "--target", browser["target"], "-Copt-level=" + str(browser["profile"]["opt-level"])] + browser["flags"])
    target_env = {}
    for line in cfg.splitlines():
        key, _, value = line.partition("=")
        key = "CARGO_CFG_" + key.upper()
        value = value.strip('"')
        target_env[key] = target_env.get(key, "") + ("," if key in target_env else "") + value
    receipt = {"schema": "oliphaunt-browser-rust-std-native-v1", "channel": browser["channel"], "target": browser["target"], "buildStd": browser["buildStd"], "targetFeatures": target_env.get("CARGO_CFG_TARGET_FEATURE", "").split(","), "compiler": {"sha256": _ARCHIVES["rustc"][1]}, "rustSrc": {"commit": _COMMIT, "sha256": _ARCHIVES["rust-src"][1]}, "archives": {component: row[1] for component, row in _ARCHIVES.items()}, "rust": browser, "std_features": ["backtrace", "panic-unwind"], "stdProfiles": {row["name"]: row["profile"] for row in graph}}
    ctx.file("construction.json", json.encode(receipt))
    ctx.file("graph.bzl", "GRAPH = " + repr(graph) + "\nRUST = " + repr(browser) + "\nTARGET_ENV = " + repr(target_env) + "\n")
    ctx.file("BUILD.bazel", """load(%s, "browser_std")
load(":graph.bzl", "GRAPH", "RUST", "TARGET_ENV")
package(default_visibility = ["//visibility:public"])
exports_files(["graph.bzl", "construction.json", "_metadata_tools/host-tools", "sources/lib/rustlib/src/rust/library/Cargo.toml", "sources/lib/rustlib/src/rust/library/Cargo.lock"])
browser_std(GRAPH, RUST, TARGET_ENV)
""" % repr(str(ctx.attr.rules)))
    return ctx.repo_metadata(reproducible = True)

browser_std_repository = repository_rule(
    implementation = _impl,
    attrs = {
        "metadata": attr.label(default = Label("@browser_sources//:rust-construction.json"), allow_single_file = True),
        "converter": attr.label(default = Label("//build_defs/wasix/browser/std:metadata.mts"), allow_single_file = True),
        "rules": attr.label(default = Label("//build_defs/wasix/browser/std:defs.bzl"), allow_single_file = True),
        "bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
    },
)
